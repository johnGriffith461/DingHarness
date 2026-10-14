// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readConfirmMode, saveConfirmMode } from "./confirmMode";
import { CONFIRM_MODES } from "@shared/ipc";

/**
 * 审批档位的持久化（§143）。
 *
 * 原来那个 chip 是**局部 state**：选了「每步确认」、离开再回来就变回「全部允许」。
 * 而主进程的工具执行层也拿不到这个选择（闸接不上）。这两件事都从"存下来"开始修。
 *
 * ⚠️ 这里**不 mock localStorage**：真实存储的往返才是要验的东西
 * （mock 掉就只剩"我调了 setItem"这种无意义断言）。
 */
describe("审批档位的持久化", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("没存过时回落到「全部允许」（= 改造前的行为，不能突然全都要确认）", () => {
    expect(readConfirmMode()).toBe("全部允许");
  });

  it("存了就记住（往返）", () => {
    for (const mode of CONFIRM_MODES) {
      saveConfirmMode(mode);
      expect(readConfirmMode(), mode).toBe(mode);
    }
  });

  it("存的是乱值也不崩，回落「全部允许」", () => {
    localStorage.setItem("dsh-canvas.confirm-mode", "EveryStepPlease");
    expect(readConfirmMode()).toBe("全部允许");
    localStorage.setItem("dsh-canvas.confirm-mode", "");
    expect(readConfirmMode()).toBe("全部允许");
  });

  it("存的位置是既有的那套键名（与 chat-settings 同期，别另起一套）", () => {
    saveConfirmMode("每步确认");
    expect(localStorage.getItem("dsh-canvas.confirm-mode")).toBe("每步确认");
  });
});
