import { describe, expect, it } from "vitest";

import { shouldSuggestReset, shouldVerify, summarizeVerify } from "./verifyLoop";

/**
 * D1：验证闭环的纯逻辑。
 * 四象限（写/未写 × 有/无测试命令）+ 摘要不超 4k + 连续两次失败才建议重置。
 */

const project = { testCommand: "pnpm test", cwd: "C:/work" };

describe("shouldVerify 四象限", () => {
  it("编码 + 写了 + 有测试命令 → 触发", () => {
    expect(shouldVerify({ wroteFiles: true, mode: "coding", project })).toEqual({
      command: "pnpm test",
      reason: "test",
      cwd: "C:/work",
    });
  });

  it("没写文件 → 不触发", () => {
    expect(shouldVerify({ wroteFiles: false, mode: "coding", project })).toBeUndefined();
  });

  it("没有测试命令 → 不触发（不猜 build/lint）", () => {
    expect(shouldVerify({ wroteFiles: true, mode: "coding", project: { cwd: "C:/work" } })).toBeUndefined();
  });

  it("办公模式 → 不触发", () => {
    expect(shouldVerify({ wroteFiles: true, mode: "office", project })).toBeUndefined();
  });
});

describe("summarizeVerify", () => {
  it("通过：ok=true，短输出原样", () => {
    const got = summarizeVerify({ exitCode: 0, stdout: "all tests passed", stderr: "" });
    expect(got.ok).toBe(true);
    expect(got.excerpt).toBe("all tests passed");
  });

  it("失败：ok=false，头尾都保留", () => {
    const body = "FAIL src/a.test.ts\n" + "x".repeat(10_000) + "\nAssertionError: expected 1 to be 2";
    const got = summarizeVerify({ exitCode: 1, stdout: body, stderr: "" });
    expect(got.ok).toBe(false);
    expect(got.excerpt).toContain("FAIL src/a.test.ts");
    expect(got.excerpt).toContain("AssertionError");
    expect(got.excerpt.length).toBeLessThanOrEqual(4100);
    expect(got.excerpt).toContain("省略");
  });

  it("成功的长输出只留尾部", () => {
    const body = "START\n" + "y".repeat(10_000) + "\nDONE 42 tests";
    const got = summarizeVerify({ exitCode: 0, stdout: body, stderr: "" });
    expect(got.excerpt).toContain("DONE 42 tests");
    expect(got.excerpt.length).toBeLessThanOrEqual(4100);
  });

  it("没有输出时也说清退出码（不假装通过/失败原因）", () => {
    expect(summarizeVerify({ exitCode: 3, stdout: "", stderr: "" }).excerpt).toContain("退出码 3");
  });

  it("stderr 会并进证据（有些测试框架只写 stderr）", () => {
    const got = summarizeVerify({ exitCode: 1, stdout: "", stderr: "boom" });
    expect(got.excerpt).toContain("boom");
  });
});

describe("shouldSuggestReset", () => {
  it("连续两次失败才建议重置", () => {
    expect(shouldSuggestReset([false])).toBe(false);
    expect(shouldSuggestReset([false, false])).toBe(true);
    expect(shouldSuggestReset([true, false])).toBe(false);
    expect(shouldSuggestReset([false, true, false])).toBe(false);
    expect(shouldSuggestReset([true, false, false])).toBe(true);
  });
});
