import { describe, expect, it } from "vitest";

import { clearConfirmRequest } from "./memoryClear";

/**
 * T-04：清空记忆前必须二次确认（不可逆的数据损失）。
 *
 * 缺陷形状：`全部清除` 原来是裸 `onClick={() => void clear()}` ——
 * 手滑一下，全部记忆当场没了，没有确认、没有撤销。
 *
 * 判据（纯函数层）：确认框的文案必须说清"清空几条 + 不可撤销"，
 * 确认按钮必须写"清空 N 条"（不写"确定"）。
 */
describe("clearConfirmRequest", () => {
  it("文案带条数与不可撤销", () => {
    const req = clearConfirmRequest(7);
    expect(req.title).toContain("清空");
    expect(req.message).toContain("7");
    expect(req.message).toContain("不可撤销");
  });

  it("确认按钮写清动作（不是「确定」）", () => {
    expect(clearConfirmRequest(3).confirmLabel).toBe("清空 3 条");
  });

  it("标成危险动作（图标要用警告）", () => {
    expect(clearConfirmRequest(1).danger).toBe(true);
  });
});
