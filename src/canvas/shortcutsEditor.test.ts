import { describe, expect, it } from "vitest";

import { SHORTCUTS, matchShortcut, mayStealInEditor, type ShortcutId } from "./shortcuts";

/**
 * 守卫：**输入框里哪些命令可以抢按键**（2026-10-16，审计 P70）。
 *
 * 修前实测：聊天框里按 Ctrl+X 会 `store.removeSelected()` —— **画布上选中的节点被剪掉**，
 * 而用户以为自己在剪切文字（`cut` 分支还 `preventDefault()` 了，连文本剪切也一起没了）。
 * 这一组用例把"改内容的命令一个都不许抢"钉住。
 */
describe("输入框里的按键归属（P70）", () => {
  /** 会改画布内容的那些命令 —— 输入框里一个都不许被画布抢走。 */
  /* 表里实际有的、且会改内容的那些（/ 由 React Flow 自己接，不在表里） */
  const MUTATING: ShortcutId[] = ["cut", "paste", "duplicate", "selectAll", "undo", "redo"];

  it("⭐ 改内容的命令在输入框里一个都不放行（Ctrl+X 会删节点就是从这里漏的）", () => {
    for (const id of MUTATING) {
      expect(mayStealInEditor(id), `「${id}」在输入框里被画布抢走了 —— 用户会丢内容`).toBe(false);
    }
  });

  it("只放行不碰内容的四个（保存 / Esc / 切标记模式 / 适应视图）", () => {
    const allowed = SHORTCUTS.map((s) => s.id).filter(mayStealInEditor);
    expect(allowed.sort(), "放行名单短是刻意的：多放行一个，用户就可能丢数据").toEqual([
      "escape",
      "fitView",
      "save",
      "toggleMarkers",
    ]);
  });

  it("命中判定与焦点无关：matchShortcut 不读 inEditor（要不要抢是调用方的事）", () => {
    const bar = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
    expect(matchShortcut({ ...bar, key: "x", ctrlKey: true, inEditor: true })).toBe("cut");
    expect(matchShortcut({ ...bar, key: "x", ctrlKey: true, inEditor: false })).toBe("cut");
  });
});
