import { describe, expect, it } from "vitest";

import { verificationMessage } from "./verifyContinue";

/**
 * P0-04：验证结果回注给模型的那条消息。
 *
 * 两条硬口径：
 * 1. 失败时必须带 **exitCode 与 stderr 尾部**（模型才能据此定位）；
 * 2. 成功时也要回注（让模型能引用证据说"验证通过"）。
 */
describe("verificationMessage", () => {
  it("失败：含命令、退出码与输出尾部", () => {
    const text = verificationMessage({
      command: "pnpm test",
      exitCode: 1,
      stdout: "FAIL src/sum.test.js\n  expected 3, got 4",
      stderr: "AssertionError: expected 3, got 4",
    });
    expect(text).toContain("pnpm test");
    expect(text).toContain("退出码 1");
    expect(text).toContain("AssertionError");
    expect(text).toContain("expected 3, got 4");
  });

  it("成功：也回注，并写清退出码 0", () => {
    const text = verificationMessage({
      command: "pnpm test",
      exitCode: 0,
      stdout: "Test Files 1 passed\nTests 2 passed",
      stderr: "",
    });
    expect(text).toContain("退出码 0");
    expect(text).toContain("Tests 2 passed");
  });

  it("超时：明确写超时，不伪装成失败输出", () => {
    const text = verificationMessage({ command: "pnpm test", exitCode: null, stdout: "", stderr: "", timedOut: true });
    expect(text).toContain("超时");
  });
});
