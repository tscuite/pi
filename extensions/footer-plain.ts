/**
 * Plain-language footer: labels instead of `↑7.2M ↓225k R44M CH99.8% $0.247 36.3%/1.0M (auto)`.
 * `/footer` toggles between this and pi's built-in footer.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const fmt = (n: number): string =>
  n < 1000 ? `${n}` : n < 10000 ? `${(n / 1000).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1000)}k` : n < 1e7 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e6)}M`;

/** Exact counts for token/cache totals: 7200000 -> 7,200,000 */
const count = (n: number): string => n.toLocaleString("en-US");

export default function (pi: ExtensionAPI) {
  let enabled = true;

  const install = (ctx: ExtensionContext) => {
    ctx.ui.setFooter((tui, theme, data) => {
      const unsubscribe = data.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
          let hit: number | undefined;
          // Every entry carrying usage: assistant replies, nested tool calls, compaction.
          for (const entry of ctx.sessionManager.getEntries() as any[]) {
            const u = entry.usage ?? entry.message?.usage;
            if (!u) continue;
            input += u.input ?? 0;
            output += u.output ?? 0;
            cacheRead += u.cacheRead ?? 0;
            cacheWrite += u.cacheWrite ?? 0;
            cost += u.cost?.total ?? 0;
            const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
            if (prompt > 0) hit = (u.cacheRead / prompt) * 100;
          }

          const usage = ctx.getContextUsage();
          const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const percent = usage?.percent;
          const label =
            percent == null ? `context ? of ${fmt(window)}` : `context ${percent.toFixed(1)}% of ${fmt(window)}`;
          const context =
            percent == null
              ? theme.fg("dim", label)
              : theme.fg(percent > 90 ? "error" : percent > 70 ? "warning" : "dim", label);

          const stats = [context];
          if (cost) stats.push(`spent $${cost.toFixed(3)}`);
          if (hit !== undefined) stats.push(`prompt cached ${hit.toFixed(1)}%`);
          const tokens = [
            input && `in ${count(input)}`,
            output && `out ${count(output)}`,
            cacheRead && `cache-read ${count(cacheRead)}`,
            cacheWrite && `cache-write ${count(cacheWrite)}`,
          ].filter(Boolean);
          if (tokens.length) stats.push(`tokens ${tokens.join(" · ")}`);

          const branch = data.getGitBranch();
          const name = ctx.sessionManager.getSessionName();
          const left = theme.fg("dim", stats.join("  ·  "));

          let right = ctx.model?.id ?? "no-model";
          if (ctx.model?.reasoning) right += ` • ${ctx.thinkingLevel ?? "off"}`;
          const withProvider =
            ctx.model && data.getAvailableProviderCount() > 1 ? `(${ctx.model.provider}) ${right}` : right;

          const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(withProvider)));
          let line = left + pad + theme.fg("dim", withProvider);
          if (visibleWidth(line) > width) line = left + " ".repeat(Math.max(1, width - visibleWidth(left))) + theme.fg("dim", right);

          const where = [ctx.cwd.replace(process.env.HOME ?? "\0", "~"), branch && `(${branch})`, name]
            .filter(Boolean)
            .join(" ");
          const lines = [truncateToWidth(theme.fg("dim", where), width, theme.fg("dim", "..."))];
          lines.push(truncateToWidth(line, width, theme.fg("dim", "...")));

          const statuses = [...data.getExtensionStatuses().values()].map((s) => s.replace(/[\r\n\t]+/g, " ").trim());
          if (statuses.length) lines.push(truncateToWidth(theme.fg("dim", statuses.join(" ")), width));
          return lines;
        },
      };
    });
  };

  // Covers startup, /new, and resume with a live context.
  pi.on("session_start", (_event, ctx) => {
    if (enabled) install(ctx);
  });

  pi.registerCommand("footer", {
    description: "Toggle the labeled footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) install(ctx);
      else ctx.ui.setFooter(undefined);
      ctx.ui.notify(enabled ? "Labeled footer on" : "Built-in footer restored", "info");
    },
  });
}
