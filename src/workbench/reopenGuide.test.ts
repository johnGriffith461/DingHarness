import { beforeEach, describe, expect, it } from "vitest";

import { __resetFirstRunFlagsForTest, reopenSetup, shouldShowFirstRun } from "./FirstRunGuide";

/**
 * F-01：**配置向导可以从设置重新打开**（2026-10-20）。
 *
 * 缺陷形状（方案 §0.1 #6）：向导右上角「先自己配」写死一个"以后永远不弹"的标记，
 * 而设置里没有重开入口 —— 误点一次就再也回不到向导，第一次配置只能靠猜。
 *
 * 判据：`reopenSetup()` 之后**即使已经钉住模型**，`shouldShowFirstRun` 也要为真
 * —— 用户是显式要求重开的，不该被"你已经有模型了"挡回去。
 */

const provider = (available: boolean) =>
  ({ id: "p", label: "P", models: ["m"], note: "", available, keyRef: "P_KEY" }) as never;

describe("reopenSetup", () => {
  beforeEach(() => __resetFirstRunFlagsForTest());

  it("⭐ 重开之后即使已经钉住模型也显示向导", () => {
    expect(shouldShowFirstRun(true, "p/m", [provider(true)])).toBe(false);
    reopenSetup();
    expect(shouldShowFirstRun(true, "p/m", [provider(true)])).toBe(true);
  });

  it("重开之后即使配置完成过（SETUP_DONE_KEY）也显示向导", () => {
    reopenSetup();
    expect(shouldShowFirstRun(true, "", [provider(false)], { setupDone: true })).toBe(true);
  });

  it("设置还没载入 / provider 还没读到时仍然不抢跑", () => {
    reopenSetup();
    expect(shouldShowFirstRun(false, "", [provider(false)])).toBe(false);
    expect(shouldShowFirstRun(true, "", null)).toBe(false);
  });
});
