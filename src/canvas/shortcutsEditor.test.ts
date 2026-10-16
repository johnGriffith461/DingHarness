import { describe, expect, it } from "vitest";

import { SHORTCUTS, matchShortcut, mayStealInEditor, type ShortcutId } from "./shortcuts";

/**
 * 守卫：**输入框里哪些命令可以抢按键**（2026-10-16，审计 P70 + P105）。
 *
 * 修前实测：聊天框里按 Ctrl+X 会 `store.removeSelected()` —— **画布上选中的节点被剪掉**，
 * 而用户以为自己在剪切文字（`cut` 分支还 `preventDefault()` 了，连文本剪切也一起没了）。
 * 这一组用例把"改内容的命令一个都不许抢"钉住。
 *
 * P105 是同一处的第二个漏项：`escape` 当时被当成"不碰内容"而留下来的，
 * 但它做的是三件事（收标记工具 / 清标记选择 / 清节点选择）—— 输入框里按 Esc 的用户
 * 看到的是"我在编辑的节点被取消选中了"。
 */
describe("输入框里的按键归属（P70 / P105）", () => {
  /** 会改画布内容的那些命令 —— 输入框里一个都不许被画布抢走。 */
  /* 表里实际有的、且会改内容的那些（/ 由 React Flow 自己接，不在表里） */
  const MUTATING: ShortcutId[] = ["cut", "paste", "duplicate", "selectAll", "undo", "redo"];

  it("⭐ 改内容的命令在输入框里一个都不放行（Ctrl+X 会删节点就是从这里漏的）", () => {
    for (const id of MUTATING) {
      expect(mayStealInEditor(id), `「${id}」在输入框里被画布抢走了 —— 用户会丢内容`).toBe(false);
    }
  });

  it("只放行不碰内容的三个（保存 / 切标记模式 / 适应视图）", () => {
    const allowed = SHORTCUTS.map((s) => s.id).filter(mayStealInEditor);
    expect(allowed.sort(), "放行名单短是刻意的：多放行一个，用户就可能丢数据").toEqual([
      "fitView",
      "save",
      "toggleMarkers",
    ]);
  });

  /**
   * ⭐ P105：`escape` 不许在输入框里生效。
   *
   * 它原来的理由是"不碰内容"，但它做的是 `setMarkerTool(null)` + `selectMarker(null)` +
   * `selectNodes([])` —— 用户焦点在聊天框 / @ 选单 / 节点内 textarea 时按 Esc 的意思
   * 是"取消这次输入"，而画布（监听在 window 上）会**照样收到**：正在编辑的节点被取消选中、
   * 排版工具条消失。所以它和 `cut` / `paste` 同属"会改掉用户眼前状态"的那一类，一律不抢。
   */
  it("⭐ Esc 不在放行名单里（输入框里按 Esc 不许清掉画布选中集）", () => {
    expect(
      mayStealInEditor("escape"),
      "又被放行了 —— 输入框里按 Esc 会静默清掉画布选中集（P105）",
    ).toBe(false);
  });

  it("命中判定与焦点无关：matchShortcut 不读 inEditor（要不要抢是调用方的事）", () => {
    const bar = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
    expect(matchShortcut({ ...bar, key: "x", ctrlKey: true, inEditor: true })).toBe("cut");
    expect(matchShortcut({ ...bar, key: "x", ctrlKey: true, inEditor: false })).toBe("cut");
    /* Esc 仍然**命中**（`matchShortcut` 说的是"这是什么键"，不是"要不要抢"） */
    expect(matchShortcut({ ...bar, key: "Escape", inEditor: true })).toBe("escape");
  });
});
