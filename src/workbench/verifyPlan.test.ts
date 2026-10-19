import { describe, expect, it } from "vitest";

import { planVerification } from "@engine/runtime/verifyLoop";

/**
 * P0-04：验证闭环的**决策**（纯函数）。
 *
 * 口径与 `shouldVerify` 一致：只有编码模式 + 确实改了文件 + 探测到测试命令才谈得上验证；
 * 档位只决定"自动跑"还是"给一张卡片"。
 */
describe("planVerification", () => {
  const project = { testCommand: "pnpm test", cwd: "C:/repo" };

  it("全部允许 + 改过文件 → auto", () => {
    const got = planVerification({ confirmMode: "全部允许", wroteFiles: true, taskMode: "coding", project });
    expect(got.action).toBe("auto");
    expect(got.command).toBe("pnpm test");
    expect(got.cwd).toBe("C:/repo");
  });

  it("按需确认 + 改过文件 → offer", () => {
    expect(planVerification({ confirmMode: "按需确认", wroteFiles: true, taskMode: "coding", project }).action).toBe("offer");
  });

  it("每步确认 + 改过文件 → offer", () => {
    expect(planVerification({ confirmMode: "每步确认", wroteFiles: true, taskMode: "coding", project }).action).toBe("offer");
  });

  it("没改文件 → skip，且说明是未验证", () => {
    const got = planVerification({ confirmMode: "全部允许", wroteFiles: false, taskMode: "coding", project });
    expect(got.action).toBe("skip");
    expect(got.reason).toContain("未验证");
  });

  it("办公模式 → skip", () => {
    expect(planVerification({ confirmMode: "全部允许", wroteFiles: true, taskMode: "office", project }).action).toBe("skip");
  });

  it("没有测试命令 → skip，不猜命令", () => {
    const got = planVerification({
      confirmMode: "全部允许",
      wroteFiles: true,
      taskMode: "coding",
      project: { cwd: "C:/repo" },
    });
    expect(got.action).toBe("skip");
    expect(got.command).toBeUndefined();
  });
});
