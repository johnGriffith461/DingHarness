import type { WorkbenchView } from "./store";

/**
 * 左栏的全局快捷键。
 *
 * 依据：本体左栏的提示文字（`.verify` 从 `E:\reverse-out\DoubaoWork\app-triage\dynamic-ui\
 * route-sweep.json` 读到的 head 原文）：
 *
 *     新工作任务        Ctrl N
 *     定时任务          Ctrl Shift T
 *     插件 · 技能 · 伙伴 Ctrl Shift S
 *     云盘              Ctrl Shift D
 *     手机遥控电脑      （无）
 *
 * ⚠️ 为什么要专门做这个文件：这些提示**早就画在左栏上了**，但全文**没有任何全局按键处理**
 * —— 也就是说那三个 `Ctrl Shift ?` 是**纯装饰**，按下去什么都不发生。
 * 这属于本项目反复清的那类"看着有、其实没用"：标签在承诺一个能力，而能力不存在。
 * （§136 查证：`src/workbench/**` 里只有 SkillPanel / ContextMenu / AccountMenu 三处
 * 局部 keydown，没有一处是全局导航用的。）
 *
 * 所以这里把「键位 → 视图」做成**一张表**，标签与绑定**同源**：
 * 改一处就够，不会再出现"标签改了、绑定没改"（本项目出现过多次的状态一致性缺陷）。
 */

export type ShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** 显示用的键位文本：本体用 `Ctrl N` 这种写法（空格分隔、无 `+`）。 */
export type NavShortcut = { keys: string; view: Exclude<WorkbenchView, "task"> };

export const NAV_SHORTCUTS: readonly NavShortcut[] = [
  { keys: "Ctrl N", view: "home" },
  { keys: "Ctrl Shift T", view: "scheduled" },
  { keys: "Ctrl Shift S", view: "plugins" },
];

/** 某视图的快捷键提示；没有就返回空串（左栏据此决定渲不渲染那枚 `wb-kbd`）。 */
export function shortcutFor(view: WorkbenchView): string {
  return NAV_SHORTCUTS.find((s) => s.view === view)?.keys ?? "";
}

/**
 * 按键 → 视图。不匹配返回 null。
 *
 * 规则：必须带 Ctrl（Windows/Linux）或 Cmd（macOS）修饰键，且**不接受 Alt**；
 * 四个键位互不冲突，所以判定就是"有没有 Shift + 是哪个字母"。
 */
export function matchShortcut(e: ShortcutEvent): WorkbenchView | null {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (!e.shiftKey) return key === "n" ? "home" : null;
  if (key === "t") return "scheduled";
  if (key === "s") return "plugins";
  return null;
}
