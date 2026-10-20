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

  /*
     * ⚠️ 默认档在 Phase 11.5 改了：**不再**回落到「全部允许」，而是「按需确认」。
     * 方案的验收是"默认档让陌生人敢用" —— 一个刚装好的人不知道这东西会动他的文件，
     * 所以默认"读放行、写与执行先问"。显式选过档位的人不受影响。
     */
  it("没存过时回落到「按需确认」（Phase 11.5 的安全默认档）", () => {
    expect(readConfirmMode()).toBe("按需确认");
  });

  it("存了就记住（往返）", () => {
    for (const mode of CONFIRM_MODES) {
      saveConfirmMode(mode);
      expect(readConfirmMode(), mode).toBe(mode);
    }
  });

  it("存的是乱值也不崩，回落「按需确认」", () => {
    localStorage.setItem("dsh-canvas.confirm-mode", "EveryStepPlease");
    expect(readConfirmMode()).toBe("按需确认");
    localStorage.setItem("dsh-canvas.confirm-mode", "");
    expect(readConfirmMode()).toBe("按需确认");
  });

  it("存的位置是既有的那套键名（与 chat-settings 同期，别另起一套）", () => {
    saveConfirmMode("每步确认");
    expect(localStorage.getItem("dsh-canvas.confirm-mode")).toBe("每步确认");
  });

  /*
   * F-04（2026-10-20）：确认疲劳逃生门上的「本会话自动接受」。
   * 按钮承诺的是**本会话** —— 所以只改内存，不写 localStorage（重启回原档）。
   */
  it("⭐ sessionOnly 只在本进程生效，不写盘", () => {
    saveConfirmMode("按需确认");
    saveConfirmMode("接受编辑", { sessionOnly: true });
    expect(readConfirmMode()).toBe("接受编辑");
    expect(localStorage.getItem("dsh-canvas.confirm-mode"), "sessionOnly 写了盘 = 按钮在撒谎").toBe("按需确认");
    /* 再做一次普通保存 = 显式长期选择，覆盖本会话档位 */
    saveConfirmMode("按需确认");
    expect(readConfirmMode()).toBe("按需确认");
  });
});
