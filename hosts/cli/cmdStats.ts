import { join } from "node:path";

import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { readTurnTraces } from "../../engine/adapters/sqliteStats";
import { describeObservability, summarizeObservability } from "../../engine/core/observability";
import { firstHourOf, type FirstHourRecord } from "../../engine/core/firstHour";
import { flag, parseIntFlagValue, type Parsed } from "./args";

/**
 * `ding stats [--days N] [--json]` —— **观测看板**（L08，2026-10-18）。
 *
 * 与 `ding sessions --cost` 的分工：那个回答"花了多少"，这个回答
 * **"跑得稳不稳、为什么失败、工具靠不靠得住"**。
 *
 * 数据来自同一份 `sessions.db`（只读），窗口默认 7 天。
 */
export async function cmdStats(p: Parsed, dataDir: string): Promise<number> {
  /*
   * F-07：`ding stats --first-hour` —— 与桌面「用量与追踪 → 第一小时」
   * 读的是**同一个推导函数**（`engine/core/firstHour.ts`），只是宿主不同。
   * 取最近一段任务/CLI 会话（聊天会话没有审批与工具流，算出来恒为 0，会误导）。
   */
  if (p.flags.has("first-hour")) {
    const store = createSqliteSessionStore(dataDir);
    try {
      const [tasks, clis] = await Promise.all([store.list({ kind: "task" }), store.list({ kind: "cli" })]);
      const picked = [...tasks, ...clis].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!picked) {
        if (p.flags.has("json")) process.stdout.write(`${JSON.stringify({ ok: true, firstHour: null, note: "还没有任务/CLI 会话" }, null, 2)}\n`);
        else process.stdout.write("还没有可统计的任务会话 —— 先跑一轮 `ding run \"…\"` 或在工作台做一件小事。\n");
        return 0;
      }
      const { records } = await store.load(picked.sessionId);
      const metrics = firstHourOf(records as FirstHourRecord[]);
      if (p.flags.has("json")) {
        process.stdout.write(`${JSON.stringify({ ok: true, sessionId: picked.sessionId, ...metrics }, null, 2)}\n`);
        return 0;
      }
      const sec = Math.round(metrics.awaitingTotalMs / 1000);
      const errors = Object.entries(metrics.errorsByKind)
        .map(([k, n]) => `${k}=${n}`)
        .join(" / ") || "无";
      process.stdout.write(`首小时（会话 ${picked.sessionId}）：\n`);
      process.stdout.write(`  第一个任务：${metrics.firstTaskStartedAt ? new Date(metrics.firstTaskStartedAt).toLocaleString("zh-CN") : "没有记录"}\n`);
      process.stdout.write(`  确认次数：${metrics.confirmations}（同一命令重复问 ${metrics.repeatedCommandAsks} 次）\n`);
      process.stdout.write(`  等待确认总时长：${sec} 秒\n`);
      process.stdout.write(`  完成声明：带证据 ${metrics.doneWithEvidence} / 不带证据 ${metrics.doneWithoutEvidence}\n`);
      process.stdout.write(`  错误：${errors}\n`);
      process.stdout.write(`  最后 5 条：${metrics.lastEventsBeforeQuit.join(" → ") || "（没有记录）"}\n`);
      return 0;
    } finally {
      store.close();
    }
  }

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
