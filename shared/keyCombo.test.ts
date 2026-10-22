import { describe, expect, it } from "vitest";

import { MODIFIER_BITS, parseKeyCombo } from "./keyCombo";

/**
 * B-03：组合键解析。
 *
 * 判据：常用单键、四种修饰键、字母数字、认不出来就**拒**（不猜一个键发出去）。
 */
describe("组合键", () => {
  it("Enter / Tab / Escape", () => {
    expect(parseKeyCombo("Enter")).toMatchObject({ ok: true, key: "Enter", keyCode: 13 });
    expect(parseKeyCombo("Tab")).toMatchObject({ ok: true, key: "Tab", keyCode: 9 });
    expect(parseKeyCombo("esc")).toMatchObject({ ok: true, key: "Escape", keyCode: 27 });
  });

  it("Control+A 带 ctrl 修饰位与 KeyA", () => {
    const got = parseKeyCombo("Control+A");
    expect(got).toMatchObject({ ok: true, code: "KeyA", modifiers: MODIFIER_BITS.ctrl });
  });

  it("Shift+Tab / Alt+ArrowDown / Meta+1", () => {
    expect(parseKeyCombo("Shift+Tab")).toMatchObject({ modifiers: MODIFIER_BITS.shift });
    expect(parseKeyCombo("Alt+ArrowDown")).toMatchObject({ code: "ArrowDown", modifiers: MODIFIER_BITS.alt });
    expect(parseKeyCombo("Meta+1")).toMatchObject({ code: "Digit1", modifiers: MODIFIER_BITS.meta });
  });

  it("⭐ 认不出来的键直接拒（不猜）", () => {
    expect(parseKeyCombo("F13").ok).toBe(false);
    expect(parseKeyCombo("Hyper+A").ok).toBe(false);
    expect(parseKeyCombo("").ok).toBe(false);
  });
});
