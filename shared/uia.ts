/**
 * **UI Automation 元素树**（G05，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 坐标版（`computer_click x,y`）的问题很具体：模型得先截图、再估比例、再点 ——
 * 估错就点歪，而"点歪"在真实桌面上可能是删了一个文件。而且它**抢焦点**：
 * 要操作就得把窗口拿到前台。
 *
 * 这一层换成**元素定位**：枚举窗口里的控件（按钮/输入框/菜单项），给每个一个
 * 稳定的 `#N` 索引，动作是"点第 N 个按钮""往第 N 个输入框写"。
 * UIA 的 `Invoke` / `Value` 模式**不需要**前台焦点（后台窗口也能调）。
 *
 * ## 为什么纯逻辑单独一份
 *
 * 枚举与动作要真起 Windows UIA（在 `electron/ipc/uia.ts`，PowerShell 桥），
 * 而"索引怎么解析、快照怎么说给模型听"是纯的 —— 这部分要能在 CI（非 Windows）
 * 上单测，否则它只能靠人肉在 Windows 上点一遍。
 */

/** 一个可操作元素（快照里给模型看的形状）。 */
export type UiaElement = {
  /** 索引（快照内稳定，`#3` 这类） */
  index: number;
  /** UIA 控件类型（Button / Edit / MenuItem …） */
  controlType: string;
  /** 可访问名（按钮文字 / 输入框标签） */
  name: string;
  /** 自动化 id（开发者用的，经常为空） */
  automationId: string;
  /** 屏幕矩形（给"它大概在哪儿"的直觉，不作为点击依据） */
  bounds: { x: number; y: number; w: number; h: number };
  /** 支持哪些模式（invoke / value / toggle / expand） */
  patterns: string[];
  /** 输入框里现在的值（有就带，**不记录用户输入的正文**） */
  value?: string;
};

/** 一次窗口快照。 */
export type UiaSnapshot = {
  /** 窗口标题 */
  window: string;
  /** 进程名（`notepad.exe` 这类） */
  process: string;
  /** 元素（深度优先顺序） */
  elements: UiaElement[];
  /** 被上限截断了没有 */
  truncated: boolean;
};

/** 能做的动作。 */
export type UiaAction = "invoke" | "setValue" | "toggle" | "focus" | "expand";

/** 动作白名单（模型给的字符串只认这些）。 */
export const UIA_ACTIONS: readonly UiaAction[] = ["invoke", "setValue", "toggle", "focus", "expand"];

/**
 * 解析元素索引。
 *
 * @param raw `#3` 或 `3`
 * @returns 索引；格式不对给 null（**不**接受任意字符串 —— 那会变成注入面）
 */
export function parseUiaRef(raw: unknown): number | null {
  const m = /^#?(\d{1,4})$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 解析动作名。
 *
 * @param raw 动作
 */
export function parseUiaAction(raw: unknown): UiaAction | null {
  const text = String(raw ?? "").trim();
  return (UIA_ACTIONS as readonly string[]).includes(text) ? (text as UiaAction) : null;
}

/**
 * 快照 → 给模型看的一段文字。
 *
 * 形态：先窗口，再一行一个元素（`#3 Button「保存」 invoke`）。
 * 只列**可操作或有名字**的控件 —— 把无名容器也列出来只会淹没真正的目标。
 *
 * @param snapshot 快照
 * @param opts.maxLines 最多列几行（默认 120）
 */
export function describeUiaSnapshot(snapshot: UiaSnapshot, opts: { maxLines?: number } = {}): string {
  const max = opts.maxLines ?? 120;
  const useful = snapshot.elements.filter((e) => e.name.trim() || e.patterns.length > 0);
  const lines = useful.slice(0, max).map((e) => {
    const pats = e.patterns.length ? ` ${e.patterns.join("/")}` : "";
    const value = e.value === undefined ? "" : ` =「${e.value.slice(0, 40)}」`;
    return `#${e.index} ${e.controlType}「${e.name || "(无名)"}」${pats}${value}`;
  });
  const more = useful.length > max ? `\n…（还有 ${useful.length - max} 个元素，缩小窗口或先 focus 再取）` : "";
  const cut = snapshot.truncated ? "\n（快照已按上限截断）" : "";
  return [
    `窗口：「${snapshot.window || "(没有标题)"}」（${snapshot.process || "未知进程"}）`,
    "",
    useful.length ? lines.join("\n") : "（这个窗口里没有可操作元素）",
    more + cut,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 这个元素支持某个动作吗（快照里已经写好了支持的模式）。
 *
 * @param element 元素
 * @param action 动作
 */
export function supportsAction(element: Pick<UiaElement, "patterns">, action: UiaAction): boolean {
  if (action === "focus") return true; // 任何元素都能尝试聚焦
  return element.patterns.includes(action);
}
