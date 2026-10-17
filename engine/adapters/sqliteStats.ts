import fs from "node:fs";

import type { TurnTraceView, UsageBucketView, UsageSummaryView } from "../../shared/ipc";
import { localDay } from "../core/ledger";
import { openSqlite } from "./sqliteDriver";

/**
 * 请求追踪与用量统计（V6-2c / V6-2d）。
 *
 * ## 为什么单独一个模块
 *
 * `SessionStore` 端口的职责是"按会话读/写/检索"，不是"跨会话聚合"。
 * 把统计塞进端口会让每个实现都被迫支持一套它没有的数据形状
 * （JSONL 那版连 SQL 都没有）。这里**只读**同一份 `sessions.db`：
 *
 *   · 不改表结构（统计是派生数据，不是事实来源）；
 *   · 只 SELECT（打开时就按只读用途使用）；
 *   · 库不存在 / 表还没建 → 返回空结果（不创建库、不抛）。
 *
 * ## 一轮怎么配对
 *
 * 日志是**每轮以 `request` 开头**（`engine/core/events.ts` 的约定）。
 * 所以按 `(session_id, seq)` 排序后，从一条 `request` 到下一条 `request` 之间
 * 就是一个完整的轮：里面的 `done` 给用量与耗时，`error` 给失败原因，
 * `tool-call` 数次数。
 */

/*
 * 类型住在 `shared/ipc.ts`（IPC 契约与统计实现**同一份**）：
 * 各写一份的话，界面上少一个字段不会报错，只会悄悄不显示。
 */
export type TurnTrace = TurnTraceView;
export type UsageBucket = UsageBucketView;
export type UsageSummary = UsageSummaryView;

/** 表不存在/库不存在时给空结果（统计是只读派生物，不该让界面报错）。 */
function hasEventsTable(db: ReturnType<typeof openSqlite>): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get() as
      | { name?: string }
      | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

/** 安全解析 payload（坏行跳过，不带走整批）。 */
function parsePayload(text: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 读最近一段时间的**逐轮追踪**。
 *
 * @param dbFile `sessions.db` 的绝对路径
 * @param opts.since 起始时刻（毫秒）；早于它的记录不读
 * @param opts.limit 最多返回多少轮（按时间倒序；默认 500）
 * @returns 追踪记录（时间倒序）
 */
export function readTurnTraces(dbFile: string, opts: { since: number; limit?: number }): TurnTrace[] {
  if (!fs.existsSync(dbFile)) return [];
  const limit = Math.max(1, Math.floor(opts.limit ?? 500));
  const db = openSqlite(dbFile);
  try {
    if (!hasEventsTable(db)) return [];
    const titles = new Map<string, string>();
    try {
      const rows = db.prepare("SELECT id, title FROM sessions").all() as { id?: string; title?: string }[];
      for (const row of rows) if (row.id) titles.set(row.id, row.title ?? "");
    } catch {
      /* 老库没有 sessions 表也无妨：标题留空 */
    }
    const rows = db
      .prepare(
        `SELECT session_id, seq, at, type, payload FROM events
          WHERE at >= ? AND type IN ('request','done','error','tool-call','tool-result')
          ORDER BY session_id, seq`,
      )
      .all(opts.since) as { session_id?: string; seq?: number; at?: number; type?: string; payload?: string }[];

    const out: TurnTrace[] = [];
    type Usage = { inputTokens?: number; outputTokens?: number; elapsedMs?: number };
    let current: {
      sessionId: string;
      request: Record<string, unknown>;
      at: number;
      tools: number;
      toolFailures: number;
      done: boolean;
      error?: string;
      usage?: Usage;
    } | null = null;
    const flush = () => {
      if (!current) return;
      const usage = current.usage;
      out.push({
        sessionId: current.sessionId,
        title: titles.get(current.sessionId) ?? "",
        requestId: String(current.request.requestId ?? ""),
        at: current.at,
        provider: String(current.request.provider ?? ""),
        model: String(current.request.model ?? ""),
        ...(usage?.elapsedMs !== undefined ? { elapsedMs: usage.elapsedMs } : {}),
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        ok: current.done && !current.error,
        toolCalls: current.tools,
        toolFailures: current.toolFailures,
        ...(current.error ? { error: current.error } : {}),
      });
      current = null;
    };

    for (const row of rows) {
      const payload = parsePayload(row.payload);
      if (!payload) continue;
      if (row.type === "request") {
        flush();
        current = { sessionId: String(row.session_id ?? ""), request: payload, at: Number(row.at ?? 0), tools: 0, toolFailures: 0, done: false };
        continue;
      }
      if (!current) continue;
      if (row.type === "tool-call") current.tools += 1;
      /* L08：工具失败率（payload 里有 error 就算一次失败） */
      else if (row.type === "tool-result" && typeof payload.error === "string" && payload.error) current.toolFailures += 1;
      else if (row.type === "done") {
        current.done = true;
        current.usage = payload.usage as Usage | undefined;
      } else if (row.type === "error") {
        current.error = String(payload.message ?? "未知错误");
      }
    }
    flush();

    return out.sort((a, b) => b.at - a.at).slice(0, limit);
  } finally {
    db.close();
  }
}

/**
 * 从追踪记录汇总用量（按天 / 按模型）。
 *
 * ⚠️ 只统计**有 `done` 且没报错**的轮：失败那一轮的 usage 可能只报了一部分，
 * 混进来会让"花了多少"偏低或偏高，而账单口径不该由我们猜。
 *
 * @param traces 追踪记录
 * @param since 起始时刻（用于标注窗口）
 * @returns 汇总
 */
export function summarizeUsage(traces: readonly TurnTrace[], since: number): UsageSummary {
  const rows = new Map<string, UsageBucket>();
  const totals = { input: 0, output: 0, turns: 0 };
  for (const trace of traces) {
    if (!trace.ok) continue;
    const day = localDay(trace.at);
    const model = trace.model || "(未记录模型)";
    const key = `${day}\u0000${model}`;
    const bucket = rows.get(key) ?? { day, model, input: 0, output: 0, turns: 0 };
    bucket.input += trace.input;
    bucket.output += trace.output;
    bucket.turns += 1;
    rows.set(key, bucket);
    totals.input += trace.input;
    totals.output += trace.output;
    totals.turns += 1;
  }

  const byDayMap = new Map<string, { day: string; input: number; output: number; turns: number }>();
  const byModelMap = new Map<string, { model: string; input: number; output: number; turns: number }>();
  for (const bucket of rows.values()) {
    const day = byDayMap.get(bucket.day) ?? { day: bucket.day, input: 0, output: 0, turns: 0 };
    day.input += bucket.input;
    day.output += bucket.output;
    day.turns += bucket.turns;
    byDayMap.set(bucket.day, day);

    const model = byModelMap.get(bucket.model) ?? { model: bucket.model, input: 0, output: 0, turns: 0 };
    model.input += bucket.input;
    model.output += bucket.output;
    model.turns += bucket.turns;
    byModelMap.set(bucket.model, model);
  }

  return {
    since,
    totals,
    byDay: [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byModel: [...byModelMap.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
    rows: [...rows.values()].sort((a, b) => (a.day === b.day ? a.model.localeCompare(b.model) : a.day.localeCompare(b.day))),
  };
}
