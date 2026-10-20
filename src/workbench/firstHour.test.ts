import { describe, expect, it } from "vitest";

import { firstHourOf, type FirstHourRecord } from "@engine/core/firstHour";
import { pickFirstHourSession } from "./firstHour";

/**
 * F-07：首小时指标（2026-10-20）。
 *
 * 造一段**形状与真实日志一致**的记录：3 次待确认（其中 1 条同签名重复问）、
 * 2 次 finish（1 次带证据）、1 条通道错误、最后 5 条事件。
 * 断言的是"从已有事件推导"——不新增事件类型，也不上报。
 */

const at = (minute: number): number => 1_760_000_000_000 + minute * 60_000;

const records: FirstHourRecord[] = [
  { type: "request", at: at(0), requestId: "r1" },
  { type: "tool-call", at: at(0), toolCallId: "c1", toolName: "run_command", input: { command: "git status" } },
  { type: "tool-result", at: at(0), toolCallId: "c1", toolName: "run_command", output: { pending: true } },
  { type: "approval", at: at(1), toolCallId: "c1", approved: true },
  { type: "tool-call", at: at(1), toolCallId: "c2", toolName: "write_file", input: { path: "D:/a.txt" } },
  { type: "tool-result", at: at(1), toolCallId: "c2", toolName: "write_file", output: { pending: true } },
  { type: "approval", at: at(3), toolCallId: "c2", approved: true },
  /* 同一命令**再次问**（签名重复） */
  { type: "tool-call", at: at(4), toolCallId: "c3", toolName: "run_command", input: { command: "git status" } },
  { type: "tool-result", at: at(4), toolCallId: "c3", toolName: "run_command", output: { pending: true } },
  { type: "approval", at: at(5), toolCallId: "c3", approved: false },
  { type: "error", at: at(6), message: "触发限流（429）" },
  { type: "tool-call", at: at(7), toolCallId: "f1", toolName: "finish", input: { status: "done", evidence: { commands: ["pnpm test"] } } },
  { type: "tool-call", at: at(8), toolCallId: "f2", toolName: "finish", input: { status: "done" } },
];

describe("firstHourOf", () => {
  const got = firstHourOf(records);

  it("⭐ 确认次数与等待时长（有审批记录的才计）", () => {
    expect(got.confirmations).toBe(3);
    /* c1 = 1 分钟，c2 = 2 分钟，c3 = 1 分钟 */
    expect(got.awaitingTotalMs).toBe(4 * 60_000);
  });

  it("⭐ 同一命令重复问 1 次（签名相同，换个 id 也算重复）", () => {
    expect(got.repeatedCommandAsks).toBe(1);
  });

  it("⭐ 完成声明：2 次，其中 1 次带证据", () => {
    expect(got.doneWithEvidence).toBe(1);
    expect(got.doneWithoutEvidence).toBe(1);
  });

  it("错误按类分", () => {
    expect(got.errorsByKind).toEqual({ rate_limit: 1 });
  });

  it("第一个任务时刻取自 request（不是「第一条日志」）", () => {
    expect(got.firstTaskStartedAt).toBe(at(0));
  });

  it("安装时刻没有来源 → 不编（undefined）", () => {
    expect(got.installToFirstTaskMs).toBeUndefined();
  });

  it("最后 5 条事件的形状", () => {
    expect(got.lastEventsBeforeQuit).toEqual([
      "tool-result:run_command",
      "approval",
      "error",
      "tool-call:finish",
      "tool-call:finish",
    ]);
  });
});

describe("pickFirstHourSession", () => {
  const summary = (sessionId: string) =>
    ({ sessionId, conversationId: "", title: "", updatedAt: 0, bytes: 0 }) as never;

  it("⭐ 跳过聊天会话，挑最近的任务/CLI 会话（聊天记录算不出确认次数）", () => {
    const picked = pickFirstHourSession([
      summary("chat-c1"),
      summary("task-t1"),
      summary("cli-r1"),
    ]);
    expect(picked?.sessionId).toBe("task-t1");
  });

  it("只有聊天会话 → null（不拿 0 冒充「首小时很顺」）", () => {
    expect(pickFirstHourSession([summary("chat-c1")])).toBeNull();
    expect(pickFirstHourSession([])).toBeNull();
  });
});
