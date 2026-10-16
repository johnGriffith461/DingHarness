import type { InternalNode, Node, XYPosition } from "@xyflow/react";
import type { NodeLookup } from "@xyflow/system";
import { hitTestRect, nodeRect, rectFromJourney } from "./nodeRect";

/**
 * 选择模式（对标原版 `box_selection` / `point_selection` / `smear_selection`）：
 *   · box   —— 在空白处拖拽拉框，框到的节点入选
 *   · point —— 单击选中 / 点空白取消；按 Ctrl / Shift 点击可多选；节点内容可编辑
 *   · smear —— 按住划过，路径经过的节点入选
 *   · pan   —— 空白处拖拽平移画布（辅助模式，与上面三种互斥）
 *
 * 三种模式的指针处理统一在 `useCanvasSelection` 里，本模块只放"可离线测试的纯逻辑"
 * 与"模式 → React Flow 参数"的映射。
 */
export const SELECTION_MODES = ["box", "point", "smear", "pan"] as const;

export type SelectionMode = (typeof SELECTION_MODES)[number];

/** 多选修饰键（Ctrl / Cmd / Shift）。 */
export function isMultiSelectKey(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey;
}

/**
 * 模式 → React Flow 参数。
 *
 * 选择手势全部自研（原因见 `useCanvasSelection`），所以这里关掉 React Flow 自带的框选；
 * 平移只在「平移」模式交给 React Flow —— 它的 d3-zoom 平移是成熟实现，没必要重写。
 */
export type SelectionModeProps = {
  /** 在画布空白处按住拖拽时是否拉框选择（自研，恒为 false）。 */
  selectionOnDrag: boolean;
  /** 在画布空白处按住拖拽时是否平移画布；数字数组表示只在这些鼠标键上平移（1 = 中键）。 */
  panOnDrag: boolean | number[];
  /** 是否允许节点/边被点选。 */
  elementsSelectable: boolean;
};

export function selectionModeProps(mode: SelectionMode): SelectionModeProps {
  switch (mode) {
    case "box":
      // 框选：节点仍可拖动/编辑，起手落在节点上时手势归节点
      return { selectionOnDrag: false, panOnDrag: [1], elementsSelectable: true };
    case "smear":
      // 涂抹选是纯手势模式：关掉节点的拖拽与点选，保证"按住划过"不会被节点抢走
      return { selectionOnDrag: false, panOnDrag: [1], elementsSelectable: false };
    case "point":
      return { selectionOnDrag: false, panOnDrag: [1], elementsSelectable: true };
    case "pan":
      // 平移模式下由 React Flow 接管空白拖拽；节点仍可点选/编辑
      return { selectionOnDrag: false, panOnDrag: true, elementsSelectable: true };
  }
}

/** 涂抹选：起点→当前点外接矩形内的节点（相交即命中，与框选同一套几何）。 */
export function smearHitTest(
  from: XYPosition,
  to: XYPosition,
  lookup: NodeLookup<InternalNode<Node>>,
): string[] {
  return hitTestRect(rectFromJourney(from, to), lookup);
}

/**
 * 框选：与涂抹选同为矩形相交语义；两者的差别只在交互方式与视觉表现。
 * （早期版本要求节点完全落在框内，实测拖动时很难"正好框住"，手感明显不对。）
 */
export function boxHitTest(
  from: XYPosition,
  to: XYPosition,
  lookup: NodeLookup<InternalNode<Node>>,
): string[] {
  return hitTestRect(rectFromJourney(from, to), lookup);
}

/** 点选：零面积矩形 → 命中包含该点的节点。 */
export function pointHitTest(
  point: XYPosition,
  lookup: NodeLookup<InternalNode<Node>>,
): string[] {
  return hitTestRect({ x: point.x, y: point.y, width: 0, height: 0 }, lookup);
}

/**
 * 按半径扩张的命中测试（多选点击用）。
 *
 * 直接把点交给 `pointHitTest` 时，落在节点边框外一点点就会"点空"；
 * 这里用带容差的矩形相交，既保证点得到，又不会误命中远处的节点。
 *
 * ⚠️ 它返回的是**候选**（`nodeLookup` 的遍历顺序，**与 z 序无关**）——
 * "到底该切哪一个"要再过一遍 `pickPointTarget`（P249）。
 */
export function clickHitTest(
  point: XYPosition,
  lookup: NodeLookup<InternalNode<Node>>,
  pad = 2,
): string[] {
  const probe = { x: point.x - pad, y: point.y - pad, width: pad * 2, height: pad * 2 };
  const hits: string[] = [];
  for (const node of lookup.values()) {
    if (node.hidden) continue;
    const box = nodeRect(node);
    const intersects =
      probe.x <= box.x + box.width &&
      box.x <= probe.x + probe.width &&
      probe.y <= box.y + box.height &&
      box.y <= probe.y + probe.height;
    if (intersects) hits.push(node.id);
  }
  return hits;
}

/**
 * 点选（多选那一支）**到底切哪一个节点** —— 几何命中之后取最上面的**一个**（2026-10-16 审计 P249）。
 *
 * ## 修的是什么
 *
 * 原来 `multiSelectBefore` 直接拿 `clickHitTest` 的整份结果去 `toggleSelection`，
 * 于是一次 Ctrl+点选会把**命中的每一个都切换一遍**：
 *   · 画框的矩形罩着整块区域，点框里的卡片 → 命中 {卡片, 画框} 两个，两个一起进选中集；
 *   · z 序重叠的两张卡片同样被一起切换。
 * 而不带修饰键的普通点选走 React Flow 的 DOM 命中，只会选中压在**最上面**的那一个 ——
 * 同一个动作两条路给两种结果。
 *
 * ## 判据：按"绘制层序"取最上面那一个
 *
 * 与 `NodeRenderer` 渲染进 DOM 的顺序同一口径（它给每个节点壳写 `style.zIndex = internals.z`）：
 *   · 主键 `internals.z` —— 画框建时 `zIndex: -1`、子节点是"父的 z + 1"、选中态另有抬升，
 *     三者都算在里面，所以算出来的层序就是屏幕上看到的层序；
 *   · 同 z 时按**文档次序**（`order`，节点数组下标）—— 后渲染的盖住先渲染的。
 *
 * ## 为什么画框要排除
 *
 * 画框本体是 `pointer-events: none`（否则它罩住的内容点不到，见 `FrameNode`），
 * 所以 **DOM 点选根本点不到画框的本体**：在框里点空白，命中的是 pane（谁都不选）。
 * 只有指针真的压在画框自己的元素上（标题栏 / 四角手柄）时，DOM 交出来的才是它 ——
 * 那时 `domId` 就是画框自己，按它放行。
 *
 * @param point 世界坐标下的点
 * @param lookup React Flow 的内部节点表
 * @param options.pad 命中容差（与 `clickHitTest` 同一个，默认 3）
 * @param options.order 文档次序（节点数组的 id 顺序）；不给就按"全都是 0"退化成只比 z
 * @param options.domId 指针下那个节点元素的 id（`elementFromPoint` 拿到的那个节点）；没有给 null
 * @returns 要切换的节点 id；没命中返回 null（**不抢这次事件**，交给 DOM 那条路）
 */
export function pickPointTarget(
  point: XYPosition,
  lookup: NodeLookup<InternalNode<Node>>,
  options: { pad?: number; order?: readonly string[]; domId?: string | null } = {},
): string | null {
  const { pad = 3, order, domId = null } = options;
  const rank = order ? new Map(order.map((id, index) => [id, index])) : null;
  let best: { id: string; z: number; order: number } | null = null;

  for (const id of clickHitTest(point, lookup, pad)) {
    const node = lookup.get(id) as (InternalNode<Node> & { zIndex?: number }) | undefined;
    if (!node) continue;
    if (node.type === "frame" && id !== domId) continue;
    const entry = { id, z: drawZ(node), order: rank?.get(id) ?? 0 };
    if (!best || entry.z > best.z || (entry.z === best.z && entry.order > best.order)) best = entry;
  }

  return best?.id ?? null;
}

/**
 * 一个节点在屏幕上的绘制层序。
 *
 * 优先取 React Flow 算好的 `internals.z`（含画框下沉 / 子节点相对父 +1 / 选中抬升），
 * 拿不到（裸节点夹具、尚未测量）时退到节点自己的 `zIndex`。
 */
export function drawZ(node: { zIndex?: number; internals?: { z?: number } }): number {
  const z = node.internals?.z;
  if (typeof z === "number") return z;
  return typeof node.zIndex === "number" ? node.zIndex : 0;
}

/**
 * 一次多选点击之后的新选中集。
 * @param current 当前选中
 * @param hit 这一次要切换的节点 id（`pickPointTarget` 只会给**一个**；
 *            仍然收数组是因为"切换一批"的语义本身成立，将来若有别的命中源也用得上）
 * @returns 新的选中集
 */
export function toggleSelection(current: string[], hit: string[]): string[] {
  if (hit.length === 0) return current;
  const set = new Set(current);
  for (const id of hit) {
    if (set.has(id)) set.delete(id);
    else set.add(id);
  }
  return Array.from(set);
}

/** 该模式是否需要画选择矩形。 */
export function modeDrawsRubberBand(mode: SelectionMode): boolean {
  return mode === "box";
}

/** 该模式是否需要画涂抹轨迹。 */
export function modeDrawsTrail(mode: SelectionMode): boolean {
  return mode === "smear";
}
