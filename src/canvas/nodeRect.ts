import { getRectsOverlappingArea, nodeToRect } from "@xyflow/system";
import type { InternalNode, Node, NodeOrigin, XYPosition } from "@xyflow/react";
import type { NodeLookup } from "@xyflow/system";

/**
 * 节点几何工具：把节点折算成世界坐标里的矩形，供选择系统做命中判定。
 *
 * 没有直接用 xyflow 的 `getNodesInside`，原因有两个：
 *   1. 它用"相交面积 ≥ 节点面积"表达"节点被完全框住"，对零面积的选择矩形（点选）
 *      会算出 0 ≥ 0 而失效；
 *   2. 它对尚未测量的节点有强制可见的兜底分支，会把"还没测到尺寸"的节点全部算命中。
 * 这里改为显式算矩形再判定，语义清楚，也方便单测。
 */

/** 世界坐标下的轴对齐矩形。 */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * 点是否落在矩形内（含边界）。
 * @param point 世界坐标点
 * @param rect 世界坐标矩形
 */
export function pointInRect(point: XYPosition, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** 两个矩形是否相交（含贴边）。 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

/** b 是否完全落在 a 内（含贴边）。 */
export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * 由路径起终点求"扫过的外接矩形"（涂抹选与框选的最小实现）。
 * 起点与终点相同（点了一下没动）时退化成零面积矩形。
 */
export function rectFromJourney(from: XYPosition, to: XYPosition): Rect {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return { x, y, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

/** 矩形外扩（给命中测试留容差）。 */
export function expandRect(rect: Rect, pad: number): Rect {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

/** 取节点的世界坐标矩形；尺寸取不到时按 0 处理（等价于没有面积，不参与命中）。 */
export function nodeRect(node: InternalNode<Node> | Node, origin: NodeOrigin = [0, 0]): Rect {
  if (isMeasuredInternalNode(node)) {
    return nodeToRect(node, origin);
  }
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? node.width ?? 0,
    height: node.measured?.height ?? node.height ?? 0,
  };
}

/**
 * React Flow 内部节点表里的节点才有 `internals`（含绝对坐标）。
 * 用它判断而不是用 xyflow 的 `isInternalNodeBase`：后者只检查几个属性是否存在，
 * 传进来的裸节点（没有 internals）会被误判，随后在取绝对坐标时崩掉。
 */
function isMeasuredInternalNode(node: InternalNode<Node> | Node): node is InternalNode<Node> {
  const internals = (node as InternalNode<Node>).internals;
  return Boolean(internals?.positionAbsolute);
}

/** 矩形与节点的相交面积（复用 xyflow 的实现）。 */
export function overlapArea(rect: Rect, nodeBox: Rect): number {
  return getRectsOverlappingArea(
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    nodeBox.x,
    nodeBox.y,
    nodeBox.width,
    nodeBox.height,
  );
}

/**
 * 命中测试：返回与选择矩形相交（或完全落入）的节点 id。
 *
 * @param rect 世界坐标下的选择矩形；零面积矩形等价于点选
 * @param lookup React Flow 的内部节点表（`useStore((s) => s.nodeLookup)`）
 * @param options.fullyInside 为真时要求节点完全落在矩形内；默认相交即命中
 * @param options.pad 命中容差，向外扩矩形，避免贴边点选差一像素
 */
export function hitTestRect(
  rect: Rect,
  lookup: NodeLookup<InternalNode<Node>>,
  options: { fullyInside?: boolean; pad?: number } = {},
): string[] {
  const { fullyInside = false, pad = 0 } = options;
  const area = pad === 0 ? rect : expandRect(rect, pad);
  const hits: string[] = [];

  for (const node of lookup.values()) {
    if (node.hidden) continue;
    const nodeBox = nodeRect(node);
    // 零面积矩形（点选）走矩形相交判定：面积算法对"点正好在节点边框上"会算成 0
    const isHit = fullyInside
      ? rectContains(area, nodeBox)
      : rectsIntersect(area, nodeBox) || overlapArea(area, nodeBox) > 0;
    if (isHit) hits.push(node.id);
  }

  return hits;
}
