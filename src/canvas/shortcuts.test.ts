import { describe, expect, it } from "vitest";
import { SHORTCUTS, matchShortcut, shortcutCheatsheet, shortcutOf } from "./shortcuts";

const base = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, inEditor: false };

describe("matchShortcut", () => {
  it("Ctrl+Z 命中撤销", () => {
    expect(matchShortcut({ ...base, key: "z", ctrlKey: true })).toBe("undo");
  });

  it("Ctrl+Shift+Z 命中重做而不是撤销（shift 要参与区分）", () => {
    expect(matchShortcut({ ...base, key: "z", ctrlKey: true, shiftKey: true })).toBe("redo");
  });

  it("Cmd（meta）在 mac 上等价于 Ctrl", () => {
    expect(matchShortcut({ ...base, key: "s", metaKey: true })).toBe("save");
  });

  it("不带修饰键的字母不命中任何 Ctrl 快捷键", () => {
    expect(matchShortcut({ ...base, key: "z" })).toBeNull();
    expect(matchShortcut({ ...base, key: "a" })).toBeNull();
  });

  it("Esc 不需要修饰键", () => {
    expect(matchShortcut({ ...base, key: "Escape" })).toBe("escape");
    expect(matchShortcut({ ...base, key: "Escape", ctrlKey: true })).toBe("escape");
  });

  it("Ctrl+M 与 Ctrl+Shift+M 是两个不同的动作", () => {
    expect(matchShortcut({ ...base, key: "m", ctrlKey: true })).toBe("toggleMarkers");
    expect(matchShortcut({ ...base, key: "m", ctrlKey: true, shiftKey: true })).toBe("clearMarkers");
  });

  it("大小写不敏感（按住 Shift 时 key 会是大写）", () => {
    expect(matchShortcut({ ...base, key: "Z", ctrlKey: true })).toBe("undo");
  });

  it("未登记的键返回 null（不误吞）", () => {
    expect(matchShortcut({ ...base, key: "k", ctrlKey: true })).toBeNull();
    expect(matchShortcut({ ...base, key: "Enter" })).toBeNull();
  });

  it("Ctrl+Alt+M 仍然命中（alt 不参与匹配，避免不同键盘布局漏判）", () => {
    expect(matchShortcut({ ...base, key: "m", ctrlKey: true, altKey: true })).toBe("toggleMarkers");
  });
});

describe("快捷键表", () => {
  it("id 不重复", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("按钮组合不重复（同一组按键只能绑一个动作）", () => {
    const combos = SHORTCUTS.map((s) => `${s.mod ? "mod+" : ""}${s.shift ? "shift+" : ""}${s.key}`);
    expect(new Set(combos).size).toBe(combos.length);
  });

  it("每个快捷键都有中文说明与 aria 串", () => {
    for (const s of SHORTCUTS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.aria.length).toBeGreaterThan(0);
    }
  });

  it("shortcutOf 能按 id 取，未知 id 明确抛错", () => {
    expect(shortcutOf("undo").keys).toBe("Ctrl+Z");
    expect(() => shortcutOf("nope" as never)).toThrow();
  });

  it("说明面板覆盖全部快捷键", () => {
    expect(shortcutCheatsheet()).toHaveLength(SHORTCUTS.length);
  });
});
