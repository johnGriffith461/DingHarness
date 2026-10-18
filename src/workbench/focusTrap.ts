/**
 * **模态浮层的键盘可达**（G16，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 设置是一个 `role="dialog" aria-modal="true"` 的整页浮层，但之前**只有 Esc**：
 * 打开之后焦点还在背后那颗按钮上，Tab 会一路跑到浮层背后的内容里 ——
 * 键盘/读屏用户会"迷失在背景里"，而视觉上根本看不出来（浮层盖着）。
 *
 * 三件事，缺一不可：
 *   ① 打开时把焦点移进浮层（移到一个可聚焦容器上，不强行跳到某个按钮）；
 *   ② Tab / Shift+Tab 在浮层内部循环（首尾相接）；
 *   ③ 关闭时把焦点还给打开它的那个元素（"我从哪来就回哪去"）。
 *
 * ## 为什么不是一整个 focus-trap 库
 *
 * 需要的就是"算下一个该聚焦谁"这一个纯判定。库会把"什么时候算可见""哪些元素算可聚焦"
 * 连同浏览器差异一起塞进来，而这个产品只有一个模态浮层（设置）——
 * 一份二十行的实现 + 单测，比引依赖更容易审。
 */

/** 能接键盘焦点的候选（顺序即 Tab 顺序）。 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * 列出容器里现在真的能聚焦的元素。
 *
 * ⚠️ 用 `offsetParent !== null` 判"可见"：`display:none` / 被折叠的子树里
 * `offsetParent` 是 null。`visibility:hidden` 与 `disabled` 另行排除 ——
 * 只看 `getBoundingClientRect` 会把隐藏元素也算进去（它们尺寸是 0 但仍在流里）。
 *
 * @param root 浮层根节点
 * @returns 可聚焦元素（文档顺序）
 */
export function focusableIn(root: HTMLElement | null | undefined): HTMLElement[] {
  if (!root) return [];
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  return nodes.filter((el) => {
    if (el.offsetParent === null && el !== document.activeElement) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return true;
  });
}

/**
 * Tab 的落点（**纯函数**，单测直接驱动）。
 *
 * @param count 可聚焦元素个数
 * @param current 当前元素在列表里的下标（不在列表里给 -1）
 * @param shift 是否 Shift+Tab
 * @returns 下一个下标；没有可聚焦元素给 -1
 */
export function nextFocusIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

/**
 * 处理一次 Tab：在浮层内循环。
 *
 * 边界行为（有意）：
 * - 焦点**不在**浮层里（例如刚打开、焦点还在容器上）：Tab 拉回第一个，Shift+Tab 拉回最后一个；
 * - 焦点在最后一个上按 Tab：回到第一个（不跑到背景里）；
 * - 焦点在第一个上按 Shift+Tab：回到最后一个。
 *
 * @param event 键盘事件（只读 key/shiftKey/preventDefault）
 * @param root 浮层根节点
 * @returns 是否消费了这次 Tab
 */
export function trapTabKey(
  event: { key: string; shiftKey: boolean; preventDefault: () => void },
  root: HTMLElement | null | undefined,
): boolean {
  if (event.key !== "Tab") return false;
  const items = focusableIn(root);
  if (!items.length) return false;
  const active = document.activeElement as HTMLElement | null;
  const current = active ? items.indexOf(active) : -1;

  /*
   * 焦点不在浮层里：**必须拦**，否则 Tab 会把焦点送到背后的内容上。
   * 空列表时已经提前返回（那时拦了也没有落点）。
   */
  if (event.shiftKey && current === 0) {
    event.preventDefault();
    items[items.length - 1]!.focus();
    return true;
  }
  if (!event.shiftKey && current === items.length - 1) {
    event.preventDefault();
    items[0]!.focus();
    return true;
  }
  if (current === -1) {
    event.preventDefault();
    items[nextFocusIndex(items.length, -1, event.shiftKey)]!.focus();
    return true;
  }
  /* 中间位置：交给浏览器（它会按文档顺序走，且能处理嵌套的可聚焦元素） */
  return false;
}
