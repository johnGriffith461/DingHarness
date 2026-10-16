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

/**
 * 输入框里**允许被画布抢走**的命令（其余按键交回浏览器做文本编辑）。
 *
 * ⚠️ 这份名单短是刻意的（2026-10-16，审计 P70 ；P105 又收紧了 `escape`）：
 * 原来这里是一张"**要挡掉**"的黑名单（只挡了 3 个，而且挡的正好是不该挡的：切标记模式 / 清标记 / 原地复制），
 * 于是 `cut`（Ctrl+X）在聊天框里按下会**删掉画布上选中的节点** —— 用户以为自己在剪切文字，
 * 而画布那份内容已经没了（而且它 `preventDefault()` 了，连文本剪切也一起没了）。
 *
 * 取舍：**少放行一个，用户最多发现"输入框里按不了"；多放行一个，用户会丢数据**。
 * 所以按"不碰画布内容"来列，而不是按"我们想得起来的那几个"。
 *
 * ⚠️⚠️ **`escape` 不在名单里**（2026-10-16，审计 P105）。
 *
 * 它看着"不碰内容"，实则**会静默改掉用户眼前的编辑状态**：画布那条 Esc 分支做三件事
 * （收标记工具 / 清标记选择 / `selectNodes([])`），而"逐级退出"这套语义**只对画布成立**——
 * 焦点在聊天框、@ 选单、节点内 textarea 里时，用户按 Esc 的意思是"取消这次输入"
 * （`ShapeNode` / `Composer` 自己也在同一按键上做事，且它们只 `preventDefault` 不 `stopPropagation`，
 * 监听挂在 `window` 上的画布会**照样收到**）。代价是正在编辑的节点被取消选中、
 * 排版工具条凭空消失，而这一下没有任何回执。
 *
 * 需要"退出画布上的某个状态"时，用户的操作对象本来就是画布（焦点在画布上、
 * 不在输入框里），所以这条限制不影响真正的用图路径。
 *
 * @param id 命中的快捷键
 * @returns true = 输入框里也让它生效
 */
export function mayStealInEditor(id: ShortcutId): boolean {
  return id === "save" || id === "toggleMarkers" || id === "fitView";
}

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
  /**
   * 事件目标是不是输入框。
   *
   * ⚠️ `matchShortcut` **故意不读它**：命中哪个快捷键与焦点在哪无关，
   * "要不要让画布抢这一下"是**调用方**的决定（见 `mayStealInEditor`，2026-10-16 审计 P70 之后）。
   * 留这个字段是因为调用方算出来顺手放进来，且测试夹具也按这个形状拼。
   */
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
