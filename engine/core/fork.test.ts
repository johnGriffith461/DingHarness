import { describe, expect, it } from "vitest";

import { forkNote, forkPoints, forkReplaysEqual, forkSession, forkSessionAt, recordsUpTo } from "./fork";
import { logLine, parseLogLine, type LogRecord } from "./events";

/**
 * fork 语义（V5-2 任务 2.5）。
 *
 * 两条判据（方案的验收）+ 一条纪律：
 *   ① **重放一致**：副本与原会话的逐轮投影相同（"分叉那一刻一模一样"）；
 *   ② **副作用警示随行**：那句白话要说清"回看不产生副作用、接着跑会"；
 *   ③ 源记录**一个字都不改**（分叉是复制，不是搬迁）。
 */

const T = (n: number) => 1_700_000_000_000 + n;

/** 一段像真的会话：一轮请求 + 一次工具调用（写盘）+ 结果 + 收尾 + 一条审批留痕。 */
function sourceRecords(): LogRecord[] {
  const lines = [
    logLine(
      { requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "写个文件" }] } as never,
      1,
      T(1),
    ),
    logLine({ requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: "a.md" } } as never, 2, T(2)),
    logLine({ requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "write_file", output: { pending: true } } as never, 3, T(3)),
    logLine({ requestId: "r1", type: "text", text: "等你确认。" } as never, 4, T(4)),
    logLine({ requestId: "r1", type: "done" } as never, 5, T(5)),
    logLine({ type: "approval", toolCallId: "c1", name: "write_file", approved: true, ok: true, line: "已保存", decidedBy: "local" } as never, 6, T(6)),
  ];
  return lines.map((line) => parseLogLine(line)!).filter(Boolean);
}

describe("2.5 · fork 为独立副本", () => {
  it("⭐ 重放一致：副本与原会话逐轮投影相同（分叉那一刻一模一样）", () => {
    const source = sourceRecords();
    const plan = forkSession(source, { source: { sessionId: "task-1" }, into: { sessionId: "task-1-fork" } });
    expect(plan.records).toHaveLength(source.length);
    const forked = plan.records.map((r, i) => ({ ...r, seq: i + 1 }) as LogRecord);
    expect(forkReplaysEqual(source, forked), "副本重放出来的东西与原会话不同").toBe(true);
  });

  it("副本记录**保留 `at`、剥掉 `seq`**（时刻是「当时说的」：新会话自己发号）", () => {
    const source = sourceRecords();
    const plan = forkSession(source, { source: { sessionId: "task-1" }, into: { sessionId: "f" } });
    expect(plan.records.map((r) => r.at)).toEqual(source.map((r) => r.at));
    for (const record of plan.records) expect((record as { seq?: number }).seq).toBeUndefined();
  });

  it("⭐ 源记录**一个字都不改**（分叉是复制，不是搬迁）", () => {
    const source = sourceRecords();
    const before = JSON.stringify(source);
    forkSession(source, { source: { sessionId: "task-1" }, into: { sessionId: "f" } });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("⭐ 副作用警示随行：说清「回看不产生副作用、接着跑会」（数了带着几次调用/几条留痕）", () => {
    const note = forkNote("task-1", "task-1-fork", sourceRecords());
    expect(note).toContain("task-1");
    expect(note).toContain("task-1-fork");
    expect(note, "没数清副本里带着什么").toContain("1 次工具调用");
    expect(note).toContain("1 条审批留痕");
    expect(note, "没说清回看与接着跑的区别").toMatch(/回看.*不产生/);
    expect(note).toMatch(/接着跑|重跑/);
    expect(note).toContain("写盘");
  });

  it("空会话也能分叉（警示里不编「含 N 次调用」）", () => {
    const empty: LogRecord[] = [];
    const plan = forkSession(empty, { source: { sessionId: "a" }, into: { sessionId: "b" } });
    expect(plan.records).toEqual([]);
    expect(plan.note).not.toContain("次工具调用");
  });
});

/** 两轮会话：第一轮收尾后有条审批，然后第二轮。 */
function twoTurnRecords(): LogRecord[] {
  const lines = [
    logLine({ requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "第一件事" }] } as never, 1, T(1)),
    logLine({ requestId: "r1", type: "text", text: "做完了" } as never, 2, T(2)),
    logLine({ requestId: "r1", type: "done" } as never, 3, T(3)),
    logLine({ type: "approval", toolCallId: "c1", name: "write_file", approved: true, ok: true, line: "已保存", decidedBy: "local" } as never, 4, T(4)),
    logLine({ requestId: "r2", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "第二件事" }] } as never, 5, T(5)),
    logLine({ requestId: "r2", type: "text", text: "也做完了" } as never, 6, T(6)),
    logLine({ requestId: "r2", type: "done" } as never, 7, T(7)),
  ];
  return lines.map((line) => parseLogLine(line)!).filter(Boolean);
}

describe("V6-4a · 任一时点 fork", () => {
  it("列出分叉点：每轮一个，带用户原话与时刻", () => {
    const points = forkPoints(twoTurnRecords());
    expect(points).toHaveLength(2);
    expect(points[0]?.label).toBe("第一件事");
    expect(points[1]?.label).toBe("第二件事");
    expect(points.map((p) => p.turn)).toEqual([1, 2]);
  });

  it("⭐ 按轮分叉：只复制到该轮收尾（包括它后面的审批留痕），后面的轮不带", () => {
    const source = twoTurnRecords();
    const plan = forkSessionAt(source, {
      source: { sessionId: "task-1" },
      into: { sessionId: "task-1-fork" },
      at: { kind: "turn", turn: 1 },
    });
    expect(plan.cutoff).toBe(4);
    expect(plan.records).toHaveLength(4);
    /* 审批记录属于第一轮：按位置切不会把它丢掉 */
    expect(plan.records.some((r) => r.type === "approval")).toBe(true);
    /* 第二轮不在副本里 */
    expect(plan.records.some((r) => r.type === "request" && r.requestId === "r2")).toBe(false);
  });

  it("按 seq 分叉与按轮分叉可以指向同一个前缀", () => {
    const source = twoTurnRecords();
    const bySeq = recordsUpTo(source, { kind: "seq", seq: 4 });
    const byTurn = recordsUpTo(source, { kind: "turn", turn: 1 });
    expect(bySeq.map((r) => r.seq)).toEqual(byTurn.map((r) => r.seq));
  });

  it("分叉点越界直接报错（不静默给空副本）", () => {
    const source = twoTurnRecords();
    expect(() => recordsUpTo(source, { kind: "turn", turn: 0 })).toThrow(/1–2/);
    expect(() => recordsUpTo(source, { kind: "turn", turn: 3 })).toThrow(/1–2/);
    expect(() => recordsUpTo(source, { kind: "seq", seq: -1 })).toThrow(/不合法/);
  });

  it("从第一轮分叉出来的副本，重放与源会话的第一轮一致", () => {
    const source = twoTurnRecords();
    const plan = forkSessionAt(source, {
      source: { sessionId: "task-1" },
      into: { sessionId: "f" },
      at: { kind: "turn", turn: 1 },
    });
    const forked = plan.records.map((r, i) => ({ ...r, seq: i + 1 }) as LogRecord);
    expect(forkReplaysEqual(recordsUpTo(source, { kind: "turn", turn: 1 }), forked)).toBe(true);
  });
});
