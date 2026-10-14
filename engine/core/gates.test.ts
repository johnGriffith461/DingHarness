import { describe, expect, it } from "vitest";

import { splitTurns, type LogRecord } from "./events";
import { approvalRecord, pendingGates } from "./gates";

/**
 * 审批闸门的语义（Phase 1 D5 尾部）。
 *
 * ## 这组断言挡的是什么
 *
 * "一次被拦下的调用"这件事，界面、日志、恢复三条路都要给出**同一个答案**。
 * 它们各自实现一遍时，最典型的失效是"界面给了按钮、点了没用"（假待办）
 * 与"批过了但留痕是个空壳"（决策记录漏带结果）—— 两种都不报错，只让用户困惑。
 */

const T = (n: number) => 1_700_000_000_000 + n;

/** 一轮：调用 `write_file`、被闸门拦下（`pending: true`），用户还没处置。 */
function blockedTurn(): LogRecord[] {
  return [
    { seq: 1, at: T(1), type: "request", requestId: "r1", provider: "p", model: "m", messages: [{ role: "user", content: "写个文件" }] },
    { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: "a.md", content: "x" } },
    { seq: 3, at: T(3), requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "write_file", output: { pending: true, notice: "等确认" } },
    { seq: 4, at: T(4), requestId: "r1", type: "done" },
  ] as unknown as LogRecord[];
}

describe("待办清单（pendingGates）", () => {
  it("⭐ 被拦下的调用带参数进清单（参数丢了就只能重问用户一次）", () => {
    const gates = pendingGates(splitTurns(blockedTurn()));
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ toolCallId: "c1", name: "write_file" });
    expect(gates[0].input).toEqual({ path: "a.md", content: "x" });
  });

  it("⭐ 已批过的不再是待办（从**收尾后**的留痕挑，不是从原始事件挑）", () => {
    const records = [
      ...blockedTurn(),
      // 用户在这一轮结束之后才点「允许」
      { seq: 5, at: T(5), type: "approval", toolCallId: "c1", name: "write_file", approved: true, ok: true, line: "✎ 写文件：已完成" },
    ] as unknown as LogRecord[];
    expect(pendingGates(splitTurns(records))).toEqual([]);
  });

  it("没被拦下的调用不进清单（正常执行完的不该在待办里）", () => {
    const records = [
      { seq: 1, at: T(1), type: "request", requestId: "r1", provider: "p", model: "m", messages: [] },
      { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a" } },
      { seq: 3, at: T(3), requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { ok: true } },
      { seq: 4, at: T(4), requestId: "r1", type: "done" },
    ] as unknown as LogRecord[];
    expect(pendingGates(splitTurns(records))).toEqual([]);
  });
});

describe("决策记录（approvalRecord）", () => {
  it("⭐ 批准：把结果一起记（只记'批过了'的话，重启后那条留痕是个空壳）", () => {
    const record = approvalRecord({
      toolCallId: "c1",
      name: "memory_save",
      approved: true,
      result: { ok: true, output: { count: 3 } },
      line: "⚙ 记忆：已保存，当前 3 条",
    });
    expect(record).toMatchObject({
      type: "approval",
      toolCallId: "c1",
      name: "memory_save",
      approved: true,
      ok: true,
      output: { count: 3 },
      line: "⚙ 记忆：已保存，当前 3 条",
    });
  });

  it("拒绝：**不带结果**（拒绝不执行，带上就成了「跑过但失败」）", () => {
    const record = approvalRecord({ toolCallId: "c1", name: "write_file", approved: false, line: "已拒绝" });
    expect(record.approved).toBe(false);
    expect("ok" in record).toBe(false);
    expect("output" in record).toBe(false);
    expect("error" in record).toBe(false);
  });

  it("批准但结果里有错误：`error` 与 `ok: false` 都要在", () => {
    const record = approvalRecord({
      toolCallId: "c1",
      name: "run_command",
      approved: true,
      result: { ok: false, error: "命令超时" },
      line: "⚙ 跑命令：超时",
    });
    expect(record).toMatchObject({ approved: true, ok: false, error: "命令超时" });
  });

  it("拒绝即使传了 result 也不记结果（避免把「拒绝」写成「执行过」）", () => {
    const record = approvalRecord({
      toolCallId: "c1",
      name: "write_file",
      approved: false,
      result: { ok: true, output: { anything: 1 } },
      line: "已拒绝",
    });
    expect("output" in record).toBe(false);
  });
});
