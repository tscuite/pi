# pi-remote-memory

pi 编码代理扩展：把本地 [pi-hermes-memory](https://www.npmjs.com/package/pi-hermes-memory) 的**全局记忆**（SQLite）单向镜像到远程 memory worker（Cloudflare Workers + D1，见 `~/Documents/public/memory`）。

不修改 pi-hermes-memory 本身——只对它的数据库做一次性快照拷贝后只读，两个模块完全解耦。

## 同步语义

对配置的 `namespace + scope + subject` 而言，**远端是本地的镜像**：

- 本地有、远端无 → 创建（服务端另有同内容幂等去重兜底）
- 本地无、远端有 → 删除，但**只删本扩展创建的行**（`metadata.source === "pi-remote-memory"`）
- 远端 cron 压缩产物（已压缩源行、`kind=compaction` 摘要）永不删除
- 本地记忆被改写/合并 → 旧行删除 + 新行创建，自动收敛

字段一一映射，无转换：`target / category / failure_reason / content` → 远端同名字段；另固定写入 `horizon="permanent"`，使镜像不参与远端 cron 的 daily→weekly→monthly 分层压缩（镜像语义 = 与本地一致，原文永不摘要）。

## 触发方式

| 时机 | 行为 |
|---|---|
| pi 会话启动 | 5 秒后后台同步一次（等 pi-hermes-memory 完成启动整理） |
| pi 会话结束 | 同步一次，总预算 8s（pi 对 `session_shutdown` 是无超时 await，不能阻塞退出） |
| 手动 | pi 内 `/sync` 命令 |
| CLI | `node index.js --dry-run` / `node index.js` |

## 日志与通知

扩展在 pi 内**不打印任何裸 console 日志**：pi TUI 接管终端后，裸输出会原样落在光标当前位置（如输入框）破坏画面。可观测性这样保证：

- **同步日志文件**：每轮同步（含 dormant、失败）追加一行到 `<agent-root>/pi-remote-memory.log`（本机即 `~/.config/pi/pi-remote-memory.log`，可用 `PI_REMOTE_MEMORY_LOGFILE` 覆盖路径；超 512KB 轮转保留一代 `.old`）。看同步是否发生/结果：`tail ~/.config/pi/pi-remote-memory.log`
- **TUI 通知**：会话启动同步完成后弹一条 info 确认（`local=… remote=… created=… deleted=…`）；真实失败 `ui.notify(error)`；dormant 静默
- `PI_REMOTE_MEMORY_VERBOSE=1` 恢复 console 打印，仅供非 TUI 场景排查，勿在正常 pi 会话中使用。CLI 模式始终打印

## 配置

默认路径：`<pi-agent-root>/pi-remote-memory.json`（跟随 `PI_CODING_AGENT_DIR`，本机即 `~/.config/pi/pi-remote-memory.json`）。可用环境变量 `PI_REMOTE_MEMORY_CONFIG` 覆盖。建议 `chmod 600`：

```json
{
  "endpoint": "https://memory.tscuite.workers.dev",
  "username": "admin",
  "password": "<basic-auth-password>",
  "namespace": "default",
  "scope": "assistant",
  "subject": "pi-agent"
}
```

`scope + subject` 决定远端隔离边界——与 VitaPet 等其他客户端互不可见。配置文件缺失时扩展静默休眠（日志里注明原因），不影响 pi 启动。

## 安装 / 卸载

注册（`~/.config/pi/settings.json`）：

```json
{ "extensions": ["/Users/tscuite/Documents/public/pi-remote-memory/index.js"] }
```

卸载：删掉该条目即可，远端数据不受影响。

## 设计边界

- 只同步**全局记忆**（`project IS NULL`）；项目级记忆（`~/.config/pi/projects-memory/`）不同步
- 远端列表单页上限 100 条，超过时日志告警（hermes 自动整理保证全局记忆规模通常远小于此）
- 快照撞上正在写入的 WAL 时本轮放弃，下个触发点自动重试
- Node ≥ 22.5（`node:sqlite`）
