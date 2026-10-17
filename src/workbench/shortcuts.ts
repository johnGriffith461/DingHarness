import type { WorkbenchView } from "./store";
import { DEFAULT_KEYMAP, formatChord, isMacPlatform, matchKeyAction, type KeyAction, type Keymap } from "@shared/keymap";
import { keymapNow } from "./appSettings";

/**
 * 左栏的全局快捷键（**可自定义**，L06）。
 *
 * 依据：接入前那版工程左栏的提示文字（逐屏截图与提取产物都在仓外工作区，未入库 ——
 * 无法复核；判据以本文件里的映射表为准）：
 *
 *     新工作任务        Ctrl N
 *     定时任务          Ctrl Shift T
 *     插件 · 技能 · 伙伴 Ctrl Shift S   ← **已作废**：那一项搬进设置了（d38fe75），
 *                                       左栏不再有它，`Ctrl Shift S` 也一并撤掉
 *     云盘              Ctrl Shift D   ← 已作废：云盘页 2026-10-16 拆了
 *
 * ⚠️ 为什么要专门做这个文件：这些提示**早就画在左栏上了**，但全文**没有任何全局按键处理**
 * —— 也就是说那三个 `Ctrl Shift ?` 是**纯装饰**，按下去什么都不发生。
 * 这属于本项目反复清的那类"看着有、其实没用"：标签在承诺一个能力，而能力不存在。
 *
 * ## L06：从"一张写死的表"变成"一份可改的键位"
 *
 * 键位的**判定与校验**搬进了 `@shared/keymap`（主进程落盘时用同一份收窄）。
 * 这里只保留"动作 → 视图"的映射与**显示文本**，读的是当前键位表 ——
 * 于是左栏显示的那串字与真正命中的键永远是同一个来源，
 * 不会出现"改了键位、提示还写着旧的"。
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

/** 动作 → 视图（两个导航动作；命令面板不是"视图"，由 Workbench 单独处理）。 */
const ACTION_VIEW: Partial<Record<KeyAction, Exclude<WorkbenchView, "task">>> = {
  newChat: "home",
  scheduled: "scheduled",
};

/** 当前平台是 mac 吗（显示 `Cmd`）。 */
function macNow(): boolean {
  try {
    return isMacPlatform(typeof navigator === "undefined" ? "" : navigator.platform);
  } catch {
    return false;
  }
}

/** 某个视图绑的是哪个动作（没有返回 null）。 */
function actionForView(view: WorkbenchView): KeyAction | null {
  const found = Object.entries(ACTION_VIEW).find(([, v]) => v === view);
  return found ? (found[0] as KeyAction) : null;
}

/**
 * 当前键位下的导航表（**动态**：改完键位立刻反映到左栏）。
 *
 * 顺序固定为"新工作任务 → 定时任务"，与左栏一致。
 */
export function navShortcuts(keymap: Keymap = keymapNow()): NavShortcut[] {
  const out: NavShortcut[] = [];
  for (const [action, view] of Object.entries(ACTION_VIEW) as Array<[KeyAction, Exclude<WorkbenchView, "task">]>) {
    const chord = keymap[action];
    if (!chord) continue;
    out.push({ keys: formatChord(chord, macNow()), view });
  }
  return out;
}

/**
 * 默认键位下的导航表。
 *
 * 测试拿它做"没改过"的基线；界面用动态的 `navShortcuts()`（见上一条）。
 */
export const NAV_SHORTCUTS: readonly NavShortcut[] = [
  { keys: "Ctrl N", view: "home" },
  { keys: "Ctrl Shift T", view: "scheduled" },
];

/** 某视图的快捷键提示；没有就返回空串（左栏据此决定渲不渲染那枚 `wb-kbd`）。 */
export function shortcutFor(view: WorkbenchView, keymap: Keymap = keymapNow()): string {
  const action = actionForView(view);
  if (!action) return "";
  const chord = keymap[action];
  return chord ? formatChord(chord, macNow()) : "";
}

/**
 * 按键 → 视图。不匹配返回 null。
 *
 * ⚠️ 这里只处理**导航动作**：命令面板的键位由 `Workbench` 用同一个
 * `matchKeyAction` 判定（它要在输入框里也能按，规矩不同），不在这里兜。
 */
export function matchShortcut(e: ShortcutEvent, keymap: Keymap = keymapNow()): WorkbenchView | null {
  const action = matchKeyAction(e, keymap);
  if (!action) return null;
  return ACTION_VIEW[action] ?? null;
}

/** 默认键位（导出给测试判断"没改过"的基线）。 */
export const DEFAULT_NAV_KEYMAP = DEFAULT_KEYMAP;
