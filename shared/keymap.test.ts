import { describe, expect, it } from "vitest";

import {
  DEFAULT_KEYMAP,
  KEY_ACTIONS,
  chordFromEvent,
  formatChord,
  matchKeyAction,
  normalizeChord,
  normalizeKeymap,
  validateChord,
  type Keymap,
} from "./keymap";

/**
 * **可自定义快捷键**（L06）的判据。
 *
 * 按用户真会遇到的情形排：
 * ① 解析/规范化不因写法不同而漂（`ctrl+shift+t` = `Mod+Shift+T`）；
 * ② 校验拦住裸键、宿主键、重复；
 * ③ 命中判定与修饰键**完全一致**（多一个少一个都不算）；
 * ④ 旧设置（没有 keymap）回落默认，坏值只回落那一项。
 */

describe("规范化与显示", () => {
  it("键序与大小写都不影响结果", () => {
    expect(normalizeChord("shift+mod+t")).toBe("Mod+Shift+T");
    expect(normalizeChord("MOD+k")).toBe("Mod+K");
    expect(normalizeChord("Ctrl+Alt+1")).toBe("Ctrl+Alt+1");
  });

  it("不合法的主键/多主键返回 null", () => {
    expect(normalizeChord("Mod+K+J")).toBeNull();
    expect(normalizeChord("Mod+Enter")).toBeNull();
    expect(normalizeChord("Mod")).toBeNull();
  });

  it("显示按平台换主修饰键", () => {
    expect(formatChord("Mod+K", false)).toBe("Ctrl K");
    expect(formatChord("Mod+K", true)).toBe("Cmd K");
    expect(formatChord("Mod+Shift+T", true)).toBe("Cmd Shift T");
  });
});

describe("校验：三条硬规矩", () => {
  it("裸键拒绝（会在打字时吃输入）", () => {
    const got = validateChord("K");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain("至少要带");
  });

  it("只有 Alt/Shift 也拒绝", () => {
    expect(validateChord("Shift+K").ok).toBe(false);
  });

  it("宿主占用的组合拒绝", () => {
    for (const chord of ["Mod+W", "Mod+R", "Mod+Shift+I", "F5", "F11"]) {
      expect(validateChord(chord).ok, `${chord} 应该被拒`).toBe(false);
    }
  });

  it("与其它动作重复 → 说清被谁占了", () => {
    const got = validateChord("Mod+N", { newChat: "Mod+N" }, "palette");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain("新工作任务");
  });

  it("与自己重复不算冲突", () => {
    expect(validateChord("Mod+K", { palette: "Mod+K" }, "palette").ok).toBe(true);
  });

  it("合法的会回规范化后的值", () => {
    const got = validateChord("mod+shift+y");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.chord).toBe("Mod+Shift+Y");
  });

  it("Mod+Shift+J 被拒（DevTools 控制台的宿主键）", () => {
    expect(validateChord("Mod+Shift+J").ok).toBe(false);
  });
});

describe("命中判定", () => {
  const keymap: Keymap = { ...DEFAULT_KEYMAP };

  it("Mod = 平台主修饰键（ctrl 或 meta 都认）", () => {
    expect(matchKeyAction({ key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, keymap)).toBe("palette");
    expect(matchKeyAction({ key: "K", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, keymap)).toBe("palette");
  });

  it("多按一个修饰键就不算（不许把 Mod+K 当 Mod+Shift+K）", () => {
    expect(matchKeyAction({ key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, keymap)).toBeNull();
    expect(matchKeyAction({ key: "k", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }, keymap)).toBeNull();
  });

  it("同主键的多个动作按 Shift 区分", () => {
    const m: Keymap = { palette: "Mod+K", newChat: "Mod+N", scheduled: "Mod+Shift+N" };
    expect(matchKeyAction({ key: "n", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, m)).toBe("newChat");
    expect(matchKeyAction({ key: "n", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, m)).toBe("scheduled");
  });

  it("解绑的动作永远不命中", () => {
    const m: Keymap = { palette: "", newChat: "Mod+N", scheduled: "Mod+Shift+T" };
    expect(matchKeyAction({ key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, m)).toBeNull();
  });
});

describe("录制与收窄", () => {
  it("只按修饰键不产出组合（等主键）", () => {
    expect(chordFromEvent({ key: "Control", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
  });

  it("录制产出规范化字符串", () => {
    expect(chordFromEvent({ key: "j", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe("Mod+Shift+J");
  });

  it("旧设置没有 keymap → 全部回默认（升级不丢键位）", () => {
    expect(normalizeKeymap(undefined)).toEqual(DEFAULT_KEYMAP);
    expect(normalizeKeymap({})).toEqual(DEFAULT_KEYMAP);
  });

  it("坏值只回落那一项，别的照留", () => {
    const got = normalizeKeymap({ palette: "Mod+J", newChat: "Bad Chord", scheduled: "Mod+Shift+Y" });
    expect(got.palette).toBe("Mod+J");
    expect(got.newChat).toBe(DEFAULT_KEYMAP.newChat);
    expect(got.scheduled).toBe("Mod+Shift+Y");
  });

  it("空串 = 用户解绑，尊重它（不回默认）", () => {
    expect(normalizeKeymap({ palette: "" }).palette).toBe("");
  });

  it("重复时后者不让抢同一个键（回默认或解绑）", () => {
    const got = normalizeKeymap({ palette: "Mod+N", newChat: "Mod+N", scheduled: "Mod+Shift+T" });
    expect(got.palette).toBe("Mod+N");
    expect(got.newChat).not.toBe("Mod+N");
    expect(got.scheduled).toBe("Mod+Shift+T");
    const unique = new Set(KEY_ACTIONS.map((a) => got[a]).filter(Boolean));
    expect(unique.size).toBe(KEY_ACTIONS.map((a) => got[a]).filter(Boolean).length);
  });

  it("默认键位本身互不冲突", () => {
    const values = KEY_ACTIONS.map((a) => DEFAULT_KEYMAP[a]);
    expect(new Set(values).size).toBe(values.length);
  });
});
