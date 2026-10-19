import { describe, expect, it } from "vitest";

import { exitCodeOf } from "./exitCode";

/**
 * A-03：CLI 退出码表（写进 help / README，也要能单测）。
 *
 * 0 成功 / 1 失败 / 2 用法错误 / 3 没有可用 provider / 4 预算暂停 / 6 等待人工确认
 */
describe("A-03 · CLI 退出码", () => {
  it("成功 → 0", () => {
    expect(exitCodeOf({ ok: true })).toBe(0);
  });

  it("失败 → 1", () => {
    expect(exitCodeOf({ ok: false, error: "炸了" })).toBe(1);
  });

  it("等待人工确认 → 6（即使这一轮 ok=true）", () => {
    expect(exitCodeOf({ ok: true, awaitingApproval: { toolCallId: "c1", name: "write_file" } })).toBe(6);
  });

  it("预算暂停 → 4", () => {
    expect(exitCodeOf({ ok: false, state: "paused" })).toBe(4);
  });

  it("用户中止 → 0（不是失败）", () => {
    expect(exitCodeOf({ ok: true, aborted: true })).toBe(0);
  });
});
