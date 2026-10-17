import { app, ipcMain } from "electron";
import path from "node:path";

import { readTurnTraces, summarizeUsage } from "../../engine/adapters/sqliteStats";

/**
 * 请求追踪与用量（V6-2c / V6-2d）的 IPC。
 *
 * 只读：打开 `userData/sessions.db` 跑 SELECT，不建表、不写库。
 * 窗口范围由渲染层给，但**在这里收窄**（天数 1–365、条数 1–2000）——
 * 渲染进程给的值一律不可信，而"给个 1e9 天"不该让主进程扫全库。
 */

export const STATS_CHANNEL = {
  turns: "stats:turns",
  usage: "stats:usage",
} as const;

const DAY = 24 * 60 * 60 * 1000;

function dbFile(): string {
  return path.join(app.getPath("userData"), "sessions.db");
}

function daysOf(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.min(365, Math.max(1, n));
}

export function registerStatsIpc(): void {
  ipcMain.handle(STATS_CHANNEL.turns, (_event, opts: unknown) => {
    const o = (opts ?? {}) as { days?: unknown; limit?: unknown };
    const days = daysOf(o.days, 30);
    const limit = Math.min(2000, Math.max(1, typeof o.limit === "number" && Number.isFinite(o.limit) ? Math.floor(o.limit) : 500));
    return readTurnTraces(dbFile(), { since: Date.now() - days * DAY, limit });
  });

  ipcMain.handle(STATS_CHANNEL.usage, (_event, opts: unknown) => {
    const o = (opts ?? {}) as { days?: unknown };
    const days = daysOf(o.days, 90);
    const since = Date.now() - days * DAY;
    /* 90 天窗口的轮数上限比追踪页宽：用量要尽量全，否则"趋势"是抽样出来的 */
    const traces = readTurnTraces(dbFile(), { since, limit: 100_000 });
    return summarizeUsage(traces, since);
  });
}
