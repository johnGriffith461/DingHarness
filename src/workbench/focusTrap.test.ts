import { describe, expect, it } from "vitest";

import { nextFocusIndex } from "./focusTrap";

/**
 * **键盘焦点循环**（G16）的纯判定。
 *
 * 设置浮层是 `aria-modal="true"`；没有这个循环，Tab 会跑到被盖住的背景里。
 * 这里钉的是"下一个该聚焦谁"的算术 —— DOM 那半在验收里真按键验。
 */

describe("nextFocusIndex", () => {
  it("正向：逐个前进，到末尾回到第一个", () => {
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, 0, false)).toBe(1);
    expect(nextFocusIndex(3, 1, false)).toBe(2);
    expect(nextFocusIndex(3, 2, false)).toBe(0);
  });

  it("反向：逐个后退，到开头回到最后一个", () => {
    expect(nextFocusIndex(3, -1, true)).toBe(2);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
    expect(nextFocusIndex(3, 1, true)).toBe(0);
    expect(nextFocusIndex(3, 2, true)).toBe(1);
  });

  it("只有一个元素：停在它自己身上", () => {
    expect(nextFocusIndex(1, 0, false)).toBe(0);
    expect(nextFocusIndex(1, 0, true)).toBe(0);
  });

  it("没有可聚焦元素：-1（调用方据此不拦 Tab）", () => {
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
    expect(nextFocusIndex(0, 0, true)).toBe(-1);
  });

  it("当前下标越界（-1 或大于长度）：从头/尾接上", () => {
    expect(nextFocusIndex(4, -1, false)).toBe(0);
    expect(nextFocusIndex(4, -1, true)).toBe(3);
  });
});
