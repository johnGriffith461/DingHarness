import { describe, expect, it } from "vitest";
import { NAV_SHORTCUTS, matchShortcut, shortcutFor, type ShortcutEvent } from "./shortcuts";

/** 造一个按键事件。 */
const ev = (key: string, mods: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

/**
 * ⭐ 把提示文本（`"Ctrl Shift T"`）**反解**成按键事件。
 *
 * 这是本文件最重要的一条断言所依赖的：它逼着「左栏显示的那串字」与
 * 「matchShortcut 真正认的键」必须是同一个东西。光测 matchShortcut 本身
 * 测不出"表里写 Ctrl Shift T、逻辑认 Ctrl Shift Y"这种错位。
 */
function parseKeys(keys: string): ShortcutEvent {
  const parts = keys.split(" ").map((p) => p.toLowerCase());
  const letter = parts.find((p) => p.length === 1);
  if (!letter) throw new Error("键位文本里没有字母: " + keys);
  return {
    key: letter,
    ctrlKey: parts.includes("ctrl"),
    metaKey: parts.includes("cmd"),
    shiftKey: parts.includes("shift"),
    altKey: parts.includes("alt"),
  };
}

describe("matchShortcut", () => {
  it("Ctrl N 开新工作任务", () => {
    expect(matchShortcut(ev("n", { ctrlKey: true }))).toBe("home");
    // 大小写不该影响判定（Shift 没按时浏览器给的是小写，按了给大写）
    expect(matchShortcut(ev("N", { ctrlKey: true }))).toBe("home");
  });

  it("Ctrl Shift T / S / D 分别到定时任务、插件、云盘", () => {
    expect(matchShortcut(ev("t", { ctrlKey: true, shiftKey: true }))).toBe("scheduled");
    expect(matchShortcut(ev("s", { ctrlKey: true, shiftKey: true }))).toBe("plugins");
    expect(matchShortcut(ev("d", { ctrlKey: true, shiftKey: true }))).toBe("cloud");
  });

  it("macOS 的 Cmd 等价于 Ctrl", () => {
    expect(matchShortcut(ev("n", { metaKey: true }))).toBe("home");
    expect(matchShortcut(ev("s", { metaKey: true, shiftKey: true }))).toBe("plugins");
  });

  it("无修饰键、或带 Alt 的，一律不认（否则打字会把界面切走）", () => {
    expect(matchShortcut(ev("n"))).toBeNull();
    expect(matchShortcut(ev("t", { shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev("n", { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it("没定义的组合不认（Ctrl Shift N 不是快捷键）", () => {
    expect(matchShortcut(ev("n", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev("k", { ctrlKey: true }))).toBeNull();
  });
});

describe("键位表与提示文本", () => {
  it("每一个视图都能查到自己的提示文本", () => {
    expect(shortcutFor("home")).toBe("Ctrl N");
    expect(shortcutFor("scheduled")).toBe("Ctrl Shift T");
    expect(shortcutFor("plugins")).toBe("Ctrl Shift S");
    expect(shortcutFor("cloud")).toBe("Ctrl Shift D");
  });

  it("没有快捷键的视图返回空串（左栏据此不渲染那枚角标）", () => {
    expect(shortcutFor("task")).toBe("");
    expect(shortcutFor("phone")).toBe("");
  });

  it("⭐ 提示文本必须与判定逻辑一致 —— 表里写的键，按下就得真的到那个视图", () => {
    for (const s of NAV_SHORTCUTS) {
      expect(matchShortcut(parseKeys(s.keys)), `${s.keys} 应当到 ${s.view}`).toBe(s.view);
    }
  });

  it("⭐ 键位不重复 —— 两个视图撞同一组键会导致一次按键切两次", () => {
    const seen = new Map<string, string>();
    for (const s of NAV_SHORTCUTS) {
      const prev = seen.get(s.keys);
      expect(prev, `${s.keys} 同时给了 ${prev} 和 ${s.view}`).toBeUndefined();
      seen.set(s.keys, s.view);
    }
  });

  it("⭐ 有快捷键的视图，字符键各不相同（否则 matchShortcut 必然错一个）", () => {
    const letters = NAV_SHORTCUTS.map((s) => parseKeys(s.keys).key);
    expect(new Set(letters).size).toBe(letters.length);
  });
});
