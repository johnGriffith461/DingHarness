import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_APPROVAL_RESUMES,
  buildApprovalResultMessage,
  clearResumeFired,
  hasPendingApproval,
  markResumeFired,
  resetApprovalResumeState,
  takeResumeBudget,
} from "./approvalResume";

beforeEach(() => resetApprovalResumeState());

describe("buildApprovalResultMessage", () => {
  it("批准：写 ok 与输出摘要", () => {
    const text = buildApprovalResultMessage([
      { name: "write_file", ok: true, output: { line: "已写入 a.md", text: "已写入 a.md" } },
    ]);
    expect(text).toContain("write_file: ok");
    expect(text).toContain("已写入 a.md");
  });

  it("拒绝：明确写用户拒绝，并提示不要重复", () => {
    const text = buildApprovalResultMessage([{ name: "write_file", rejected: true, ok: true }]);
    expect(text).toContain("用户拒绝");
    expect(text).toContain("不要重复");
  });

  it("失败：带错误原因（模型据此换方法）", () => {
    const text = buildApprovalResultMessage([{ name: "run_command", ok: false, error: "命令不存在" }]);
    expect(text).toContain("error");
    expect(text).toContain("命令不存在");
  });

  it("批量三条结果都出现在同一条消息里", () => {
    const text = buildApprovalResultMessage([
      { name: "a", ok: true },
      { name: "b", ok: true },
      { name: "c", ok: false, error: "boom" },
    ]);
    expect(text).toContain("- a: ok");
    expect(text).toContain("- b: ok");
    expect(text).toContain("- c: error");
  });
});

describe("续跑预算与去重", () => {
  it("同一 step 最多续 3 次", () => {
    expect(takeResumeBudget("t1", "s1")).toBe(true);
    expect(takeResumeBudget("t1", "s1")).toBe(true);
    expect(takeResumeBudget("t1", "s1")).toBe(true);
    expect(takeResumeBudget("t1", "s1")).toBe(false);
    expect(MAX_APPROVAL_RESUMES).toBe(3);
  });

  it("同一批只续一次（mark 第二次返回 false）", () => {
    expect(markResumeFired("t1", "s1")).toBe(true);
    expect(markResumeFired("t1", "s1")).toBe(false);
    clearResumeFired("t1", "s1");
    expect(markResumeFired("t1", "s1")).toBe(true);
  });

  it("还有 pending 时不续", () => {
    expect(hasPendingApproval([{ toolCallId: "a", name: "x", ok: false, line: "", pending: true }])).toBe(true);
    expect(hasPendingApproval([{ toolCallId: "a", name: "x", ok: true, line: "" }])).toBe(false);
  });
});
