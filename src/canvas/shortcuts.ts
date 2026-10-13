/**
 * 快捷键系统（阶段 5.5）。
 *
 * 用一张表声明所有快捷键，好处是可枚举 —— 界面上能直接渲染"快捷键说明"，
 * 也能用 `aria-keyshortcuts` 把按键信息挂到对应控件上（无障碍与可发现性）。
 *
 * 命中规则明确写死，不做"猜"：
 *   · `mod` 表示 Ctrl（macOS 上是 Cmd）
 *   · 只有 `mod` 组合会阻止浏览器默认行为（避免抢掉 Ctrl+C 这类系统操作）
 *   · 纯字母键只在**焦点不在输入框**时生效
 */

export type ShortcutId =
  | "undo"
  | "redo"
  | "selectAll"
  | "save"
  | "fitView"
  | "duplicate"
  | "toggleMarkers"
  | "clearMarkers"
  | "copy"
  | "cut"
  | "paste"
  | "escape";

export type Shortcut = {
  id: ShortcutId;
  /** 展示用的按键串，例如 `Ctrl+Z`。 */
  keys: string;
  /** `aria-keyshortcuts` 用的规范串。 */
  aria: string;
  label: string;
  /** 需要 Ctrl/Cmd。 */
  mod?: boolean;
  /** 需要 Shift。 */
  shift?: boolean;
  /** 匹配的键（小写）。 */
  key: string;
};

export const SHORTCUTS: Shortcut[] = [
  { id: "undo", keys: "Ctrl+Z", aria: "Control+Z", label: "撤销", mod: true, key: "z" },
  { id: "redo", keys: "Ctrl+Shift+Z", aria: "Control+Shift+Z", label: "重做", mod: true, shift: true, key: "z" },
  { id: "selectAll", keys: "Ctrl+A", aria: "Control+A", label: "全选节点", mod: true, key: "a" },
  { id: "save", keys: "Ctrl+S", aria: "Control+S", label: "立即保存", mod: true, key: "s" },
  { id: "fitView", keys: "Ctrl+0", aria: "Control+0", label: "适应视图", mod: true, key: "0" },
  { id: "duplicate", keys: "Ctrl+D", aria: "Control+D", label: "原地复制选中节点", mod: true, key: "d" },
  { id: "copy", keys: "Ctrl+C", aria: "Control+C", label: "复制选中节点", mod: true, key: "c" },
  { id: "cut", keys: "Ctrl+X", aria: "Control+X", label: "剪切选中节点", mod: true, key: "x" },
  { id: "paste", keys: "Ctrl+V", aria: "Control+V", label: "粘贴到视口中心", mod: true, key: "v" },
  { id: "toggleMarkers", keys: "Ctrl+M", aria: "Control+M", label: "打开/关闭标记模式", mod: true, key: "m" },
  { id: "clearMarkers", keys: "Ctrl+Shift+M", aria: "Control+Shift+M", label: "清空标记", mod: true, shift: true, key: "m" },
  { id: "escape", keys: "Esc", aria: "Escape", label: "退出当前工具 / 取消选择", key: "escape" },
];

/** 按 id 取快捷键定义。 */
export function shortcutOf(id: ShortcutId): Shortcut {
  const found = SHORTCUTS.find((s) => s.id === id);
  if (!found) throw new Error(`未知快捷键：${id}`);
  return found;
}

/** 一次键盘事件里跟匹配有关的部分。 */
export type KeyLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** 事件目标是不是输入框（输入框里不抢纯字母键）。 */
  inEditor: boolean;
};

/**
 * 判断这次按键命中哪个快捷键。
 *
 * @param event 键盘事件的关键字段
 * @returns 命中的快捷键 id；没命中返回 null
 */
export function matchShortcut(event: KeyLike): ShortcutId | null {
  const key = event.key.toLowerCase();
  // Esc 与功能键不要求修饰键
  if (key === "escape") return "escape";

  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return null;
  // 带 Ctrl 的组合即使焦点在输入框里也应当生效（Ctrl+S / Ctrl+Z 是全局语义），
  // 唯一的例外是 Ctrl+Backspace/Delete 这类文本编辑操作，这里的表里没有，故不特判。

  for (const shortcut of SHORTCUTS) {
    if (!shortcut.mod) continue;
    if (shortcut.key !== key) continue;
    if (Boolean(shortcut.shift) !== event.shiftKey) continue;
    return shortcut.id;
  }
  return null;
}

/** 渲染给"快捷键说明"面板用。 */
export function shortcutCheatsheet(): Array<{ keys: string; label: string }> {
  return SHORTCUTS.map((s) => ({ keys: s.keys, label: s.label }));
}
