/**
 * pi-remote-memory — 把本地 pi-hermes-memory 的全局记忆单向镜像到远程 memory worker。
 *
 * 不修改 pi-hermes-memory 本身：只对它的 SQLite 做一次性快照拷贝后只读。
 *
 * 同步语义（对配置的 namespace/scope/subject 而言，远端是本地的镜像）：
 *   - 本地有、远端无        → POST 创建（服务端另有内容级幂等去重兜底）
 *   - 本地无、远端有        → 仅删除“本扩展创建的行”（metadata.source === SOURCE_TAG）；
 *                            远端 cron 压缩产物（compacted / kind=compaction）永不删除
 *   - 本地记忆被改写/合并   → 表现为旧行删除 + 新行创建
 *
 * 触发方式：
 *   - pi 会话启动 5 秒后自动同步一次（后台，不阻塞；完成后 ui.notify 一条 info 统计）
 *   - pi 会话结束时自动同步一次（总预算 8s，不阻塞退出）
 *   - 手动：/sync 命令，或 `node index.js [--dry-run]`
 *   - pi 内部不打印任何裸 console（会破坏 TUI 画面）：
 *       · 每次同步（含 dormant/失败）追加一行到 <agent-root>/pi-remote-memory.log
 *       · 启动同步完成后 ui.notify(info) 带统计数字；失败 ui.notify(error)
 *       · 排查非 TUI 场景可用 PI_REMOTE_MEMORY_VERBOSE=1（会打印 console，勿在 TUI 用）
 *
 * 配置：默认 <agent-root>/pi-remote-memory.json（跟随 PI_CODING_AGENT_DIR，
 * 本机即 ~/.config/pi/pi-remote-memory.json；建议 chmod 600）
 *   { "endpoint", "username", "password", "namespace?", "scope?", "subject?" }
 * 环境变量 PI_REMOTE_MEMORY_CONFIG 可覆盖配置文件路径。
 */

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_TAG = 'pi-remote-memory';
const DEFAULT_SCOPE = 'assistant';
const DEFAULT_SUBJECT = 'pi-agent';
const REMOTE_LIST_CAP = 100; // worker GET /api/memories 单页上限
const FETCH_TIMEOUT_MS = 20_000;
const SHUTDOWN_SYNC_BUDGET_MS = 8_000; // session_shutdown 同步总预算：pi 对该 handler 是无超时 await 的

// 扩展模式下默认静默：pi TUI 接管终端后，裸 console 输出会原样打在光标当前位置
// （比如输入框里）破坏画面。排查时设 PI_REMOTE_MEMORY_VERBOSE=1。
const VERBOSE = process.env.PI_REMOTE_MEMORY_VERBOSE === '1';
let cliMode = false; // node index.js 直接运行时置 true

function log(message) {
  if (cliMode || VERBOSE) {
    console.log(`[${SOURCE_TAG}] ${message}`);
  }
}

// 持久化同步日志：每轮同步追加一行，观察同步是否发生/结果如何都看这里
//（pi 内不能靠 console：裸输出会破坏 TUI 画面）。超过 512KB 轮转保留一代 .old。
const LOG_ROTATE_BYTES = 512 * 1024;

function logFilePath() {
  return process.env.PI_REMOTE_MEMORY_LOGFILE
    ?? path.join(resolveAgentRoot(), 'pi-remote-memory.log');
}

function appendLog(message) {
  try {
    const file = logFilePath();
    if (existsSync(file) && statSync(file).size > LOG_ROTATE_BYTES) {
      renameSync(file, `${file}.old`);
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // 日志写入失败不影响同步本身
  }
}

function resolveAgentRoot() {
  // 与 pi-hermes-memory 的 AGENT_ROOT 解析保持一致
  if (process.env.PI_CODING_AGENT_DIR) {
    return path.resolve(process.env.PI_CODING_AGENT_DIR.replace(/^~(?=\/|$)/, homedir()));
  }
  return path.join(homedir(), '.pi', 'agent');
}

function loadConfig() {
  const configPath =
    process.env.PI_REMOTE_MEMORY_CONFIG
    ?? path.join(resolveAgentRoot(), 'pi-remote-memory.json');

  if (!existsSync(configPath)) {
    return { error: `config not found: ${configPath}` };
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    return { error: `invalid config ${configPath}: ${error.message}` };
  }

  for (const key of ['endpoint', 'username', 'password']) {
    if (!config[key]) return { error: `config missing field: ${key}` };
  }

  return {
    value: {
      endpoint: config.endpoint.replace(/\/+$/, ''),
      username: config.username,
      password: config.password,
      namespace: config.namespace || 'default',
      scope: config.scope || DEFAULT_SCOPE,
      subject: config.subject || DEFAULT_SUBJECT,
    },
  };
}

function resolveLocalDbPath() {
  return path.join(resolveAgentRoot(), 'pi-hermes-memory', 'sessions.db');
}

/** 快照拷贝（main + wal，不拷 shm，让 SQLite 在临时副本里自行恢复），避免与运行中的 pi 抢锁。 */
function readLocalMemories(dbPath) {
  const snapshotDir = mkdtempSync(path.join(tmpdir(), 'pi-remote-memory-'));
  const snapshotPath = path.join(snapshotDir, 'memories.db');

  try {
    copyFileSync(dbPath, snapshotPath);
    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) copyFileSync(walPath, `${snapshotPath}-wal`);

    const db = new DatabaseSync(snapshotPath); // 读写打开临时副本，允许 WAL 恢复
    try {
      return db
        .prepare(
          `SELECT id, target, category, content, failure_reason
           FROM memories
           WHERE project IS NULL OR project = ''`,
        )
        .all()
        .map((row) => ({
          ...row,
          hash: createHash('sha1').update(String(row.content)).digest('hex'),
        }));
    } finally {
      db.close();
    }
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

async function fetchRemoteRows(config) {
  const url = new URL('/api/memories', config.endpoint);
  for (const [key, value] of [
    ['namespace', config.namespace],
    ['scope', config.scope],
    ['subject', config.subject],
    ['include_compacted', '1'],
    ['limit', String(REMOTE_LIST_CAP)],
  ]) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { Authorization: authHeader(config) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`remote list failed: HTTP ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length >= REMOTE_LIST_CAP) {
    log(`warning: remote rows reached the ${REMOTE_LIST_CAP} list cap; older rows are invisible to this sync`);
  }
  return items.map((row) => ({
    ...row,
    hash: createHash('sha1').update(String(row.content)).digest('hex'),
  }));
}

function authHeader(config) {
  const token = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  return `Basic ${token}`;
}

async function createRemoteRow(config, row) {
  const response = await fetch(new URL('/api/memories', config.endpoint), {
    method: 'POST',
    headers: { Authorization: authHeader(config), 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      namespace: config.namespace,
      scope: config.scope,
      subject: config.subject,
      // permanent：镜像语义 = 与本地一致（只增、按需检索）；不参与远端 cron 的
      // daily→weekly→monthly→permanent 分层压缩，避免原文被机械摘要替换。
      horizon: 'permanent',
      target: row.target || 'memory',
      category: row.category || null,
      failure_reason: row.failure_reason || null,
      content: row.content,
      tags: [SOURCE_TAG],
      metadata: { source: SOURCE_TAG },
    }),
  });
  if (!response.ok) {
    throw new Error(`create failed HTTP ${response.status}: ${await response.text()}`);
  }
}

async function deleteRemoteRow(config, id) {
  const response = await fetch(new URL(`/api/memories/${id}`, config.endpoint), {
    method: 'DELETE',
    headers: { Authorization: authHeader(config) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`delete ${id} failed HTTP ${response.status}`);
  }
}

let running = false;

async function runSync({ dryRun = false } = {}) {
  if (running) {
    log('sync already in progress, skipped');
    return { skipped: true };
  }
  running = true;

  try {
    const configResult = loadConfig();
    if (configResult.error) {
      log(`dormant: ${configResult.error}`);
      appendLog(`dormant: ${configResult.error}`);
      return { dormant: configResult.error };
    }
    const config = configResult.value;

    const dbPath = resolveLocalDbPath();
    if (!existsSync(dbPath)) {
      log(`dormant: local memory db not found: ${dbPath}`);
      appendLog(`dormant: local memory db not found: ${dbPath}`);
      return { dormant: `local memory db not found: ${dbPath}` };
    }

    let localRows;
    try {
      localRows = readLocalMemories(dbPath);
    } catch (error) {
      // 快照撞上正在写入的 WAL 属正常竞态，本轮放弃，下个触发点重试
      log(`snapshot failed (will retry on next trigger): ${error.message}`);
      appendLog(`snapshot failed (will retry on next trigger): ${error.message}`);
      return { dormant: `snapshot failed (will retry): ${error.message}` };
    }

    const remoteRows = await fetchRemoteRows(config);

    const localHashes = new Set(localRows.map((row) => row.hash));
    const remoteHashes = new Set(remoteRows.map((row) => row.hash));

    const toCreate = localRows.filter((row) => !remoteHashes.has(row.hash));
    const toDelete = remoteRows.filter((row) => {
      if (row.compacted) return false; // 已压缩源行保留为历史
      if (row.metadata?.kind === 'compaction') return false; // 压缩摘要不删
      if (row.metadata?.source !== SOURCE_TAG) return false; // 只删自己创建的行
      return !localHashes.has(row.hash);
    });

    log(
      `local=${localRows.length} remote=${remoteRows.length} create=${toCreate.length} delete=${toDelete.length}${dryRun ? ' (dry-run)' : ''}`,
    );
    appendLog(
      `local=${localRows.length} remote=${remoteRows.length} create=${toCreate.length} delete=${toDelete.length}${dryRun ? ' (dry-run)' : ''}`,
    );

    const errors = [];
    let created = 0;
    let deleted = 0;

    for (const row of toCreate) {
      try {
        if (!dryRun) await createRemoteRow(config, row);
        created += 1;
      } catch (error) {
        errors.push(error.message);
      }
    }

    for (const row of toDelete) {
      try {
        if (!dryRun) await deleteRemoteRow(config, row.id);
        deleted += 1;
      } catch (error) {
        errors.push(error.message);
      }
    }

    if (errors.length > 0) {
      log(`${errors.length} errors:\n  ${errors.join('\n  ')}`);
      appendLog(`${errors.length} errors: ${errors.join(' | ')}`);
      return { error: `${errors.length} sync errors` };
    }

    if (!dryRun && (created > 0 || deleted > 0)) {
      log(`done: created=${created} deleted=${deleted}`);
    }

    return { created, deleted, local: localRows.length, remote: remoteRows.length };
  } catch (error) {
    log(`sync failed: ${error.message}`);
    appendLog(`sync failed: ${error.message}`);
    return { error: error.message };
  } finally {
    running = false;
  }
}

// ── pi 扩展入口 ──────────────────────────────────────────────────────────────

export default function register(pi) {
  let pendingTimer = null;

  const scheduleBackgroundSync = (delayMs, ctx) => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      runSync()
        .then((result) => {
          // 启动同步总是给一条 info 确认（含统计数字）；失败报 error；dormant 静默
          if (!ctx?.hasUI) return;
          if (result?.error) {
            ctx.ui.notify(`pi-remote-memory sync failed: ${result.error}`, 'error');
          } else if (result?.skipped) {
            ctx.ui.notify('pi-remote-memory: sync already running', 'warning');
          } else if (result?.dormant) {
            // 无配置/无库：预期内，静默（日志里有）
          } else {
            ctx.ui.notify(
              `pi-remote-memory synced: local=${result.local} remote=${result.remote} created=${result.created} deleted=${result.deleted}`,
              'info',
            );
          }
        })
        .catch(() => {});
    }, delayMs);
    pendingTimer.unref?.();
  };

  pi.on('session_start', (_event, ctx) => {
    // 等 pi-hermes-memory 完成启动期迁移/整理后再同步
    scheduleBackgroundSync(5_000, ctx);
  });

  pi.on('session_shutdown', () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    // pi 无超时地 await 本 handler：给同步设总预算，避免退出被网络阻塞
    const budget = new Promise((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_SYNC_BUDGET_MS);
      timer.unref?.();
    });
    return Promise.race([runSync().then(() => {}), budget]);
  });

  pi.registerCommand('sync', {
    description: 'Sync local pi memories to the remote memory worker',
    handler: async (_args, ctx) => {
      const result = await runSync();
      if (result.skipped) {
        ctx.ui.notify('pi-remote-memory: sync already running', 'warn');
      } else if (result.dormant) {
        ctx.ui.notify(`pi-remote-memory: dormant (${result.dormant})`, 'warn');
      } else if (result.error) {
        ctx.ui.notify(`pi-remote-memory: ${result.error}`, 'error');
      } else {
        ctx.ui.notify(
          `pi-remote-memory: created=${result.created} deleted=${result.deleted}`,
          'info',
        );
      }
    },
  });
}

// ── 独立 CLI：node index.js [--dry-run] ─────────────────────────────────────

const invokedAsScript =
  typeof process !== 'undefined'
  && process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  cliMode = true;
  const dryRun = process.argv.includes('--dry-run');
  const result = await runSync({ dryRun });
  if (result.error) process.exitCode = 1;
}
