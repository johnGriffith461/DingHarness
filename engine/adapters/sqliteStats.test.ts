import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { localDay } from "../core/ledger";
import type { LogInputAt } from "../ports/store";
import { createSqliteSessionStore } from "./sqliteStore";
import { readTurnTraces, summarizeUsage } from "./sqliteStats";

/**
 * 请求追踪与用量（V6-2c / V6-2d）。
 *
 * 守的判据：
 *   ① 按轮配对（request → done/error），失败轮如实标 `ok:false`；
 *   ② 用量只统计**成功收尾**的轮（失败轮 usage 不完整，混进去账单口径就散了）；
 *   ③ 库不存在 → 空结果（统计是只读派生物，不该让页面报错）。
 */

const dirs: string[] = [];
const T = 1_700_000_000_000;

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-stats-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function seed(dir: string): Promise<void> {
  const store = createSqliteSessionStore(dir);
  const records: LogInputAt[] = [
    { at: T, requestId: "r1", type: "request", provider: "deepseek", model: "deepseek-chat", messages: [{ role: "user", content: "一" }] },
    { at: T + 10, requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a" } },
    { at: T + 20, requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { ok: true } },
    { at: T + 30, requestId: "r1", type: "done", usage: { inputTokens: 100, outputTokens: 50, elapsedMs: 1200 } },
    { at: T + 100, requestId: "r2", type: "request", provider: "deepseek", model: "deepseek-chat", messages: [{ role: "user", content: "二" }] },
    { at: T + 200, requestId: "r2", type: "error", message: "上游 502" },
  ] as LogInputAt[];
  await store.append("chat-1", records);
  /* 给会话一个标题，追踪页要显示它 */
  await store.append("chat-2", [
    { at: T + 300, requestId: "r3", type: "request", provider: "p", model: "m2", messages: [{ role: "user", content: "三" }] },
  ] as LogInputAt[]);
  store.close();
}

describe("请求追踪", () => {
  it("按轮配对：成功轮带耗时/用量，失败轮标出来（时间倒序）", async () => {
    const dir = tmp();
    await seed(dir);
    const traces = readTurnTraces(path.join(dir, "sessions.db"), { since: 0 });

    expect(traces).toHaveLength(3);
    expect(traces[0]?.requestId).toBe("r3");
    const r1 = traces.find((t) => t.requestId === "r1")!;
    expect(r1.ok).toBe(true);
    expect(r1.elapsedMs).toBe(1200);
    expect(r1.input).toBe(100);
    expect(r1.output).toBe(50);
    expect(r1.toolCalls).toBe(1);
    expect(r1.model).toBe("deepseek-chat");

    const r2 = traces.find((t) => t.requestId === "r2")!;
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("502");
    expect(r2.input).toBe(0);
  });

  it("since 窗口真的过滤（早于窗口的轮不读）", async () => {
    const dir = tmp();
    await seed(dir);
    expect(readTurnTraces(path.join(dir, "sessions.db"), { since: T + 50 })).toHaveLength(2);
  });

  it("库不存在 → 空结果（不建库、不抛）", () => {
    const dir = tmp();
    expect(readTurnTraces(path.join(dir, "nope.db"), { since: 0 })).toEqual([]);
    expect(fs.existsSync(path.join(dir, "nope.db"))).toBe(false);
  });
});

describe("用量汇总", () => {
  it("只统计成功收尾的轮，按天与按模型两个切面都对", async () => {
    const dir = tmp();
    await seed(dir);
    const traces = readTurnTraces(path.join(dir, "sessions.db"), { since: 0 });
    const summary = summarizeUsage(traces, 0);

    expect(summary.totals).toEqual({ input: 100, output: 50, turns: 1 });
    expect(summary.byDay).toEqual([{ day: localDay(T), input: 100, output: 50, turns: 1 }]);
    expect(summary.byModel[0]).toMatchObject({ model: "deepseek-chat", input: 100, output: 50, turns: 1 });
    expect(summary.rows).toHaveLength(1);
  });

  it("空输入给全零（不编数据）", () => {
    const summary = summarizeUsage([], 0);
    expect(summary.totals).toEqual({ input: 0, output: 0, turns: 0 });
    expect(summary.byDay).toEqual([]);
    expect(summary.byModel).toEqual([]);
  });
});
