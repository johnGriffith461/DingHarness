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
 * 一次多选点击之后的新选中集。
 * @param current 当前选中
 * @param hit 命中节点（从下层到上层）
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
