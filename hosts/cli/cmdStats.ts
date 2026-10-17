import { join } from "node:path";

import { readTurnTraces } from "../../engine/adapters/sqliteStats";
import { describeObservability, summarizeObservability } from "../../engine/core/observability";
import { flag, parseIntFlagValue, type Parsed } from "./args";

/**
 * `ding stats [--days N] [--json]` —— **观测看板**（L08，2026-10-18）。
 *
 * 与 `ding sessions --cost` 的分工：那个回答"花了多少"，这个回答
 * **"跑得稳不稳、为什么失败、工具靠不靠得住"**。
 *
 * 数据来自同一份 `sessions.db`（只读），窗口默认 7 天。
 */
export function cmdStats(p: Parsed, dataDir: string): number {
  const days = parseIntFlagValue(flag(p, "days"), "days", { min: 1, max: 365, fallback: 7 });
  if (!days.ok) {
    process.stderr.write(`${days.message}\n`);
    return 2;
  }
  const since = Date.now() - days.value * 86_400_000;
  const traces = readTurnTraces(join(dataDir, "sessions.db"), { since, limit: 2000 });
  const summary = summarizeObservability(traces);

  if (p.flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ days: days.value, since, ...summary }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`最近 ${days.value} 天（${traces.length} 轮有记录）：\n`);
  for (const line of describeObservability(summary)) process.stdout.write(`  ${line}\n`);
  if (!traces.length) {
    process.stdout.write("\n（这段时间没有跑过任何一轮；`ding run \"…\"` 之后再看）\n");
  }
  return 0;
}
