import type { Rect } from "./nodeRect";
import type { CanvasNode } from "./types";

/**
 * 画框的"框住哪些节点"判定（阶段 8.4，对标原版 `moveFrameWithChildren`）。
 *
 * 关键在于**用节点的中心点判归属**，而不是外接矩形相交：
 * 设计工具里两个节点边缘擦一点边是常态，用相交判会把半个身子在外面的卡片也吞进来，
 * 拖画框时把它们一起拽走会让人莫名其妙。中心点在框内 = 视觉上"这张卡片属于这一屏"。
 *
 * 画面框自己不能成为自己的子节点（`candidate !== frameId`），
 * 画框也不该嵌套画框（`type === "frame"` 排除）—— 嵌套会让父子关系形成环，
 * React Flow 会直接报错，所以在这一层就挡掉。
 */

/** 取节点的外接矩形（用测量到的尺寸优先，没有就退回初始尺寸）。 */
export function nodeBox(node: Pick<CanvasNode, "position" | "width" | "height">, fallback = { width: 320, height: 200 }): Rect {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? fallback.width,
    height: node.height ?? fallback.height,
  };
}

/** 点是否在矩形内。 */
export function pointIn(box: Rect, point: { x: number; y: number }): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

/**
 * 算出某个画框此刻框住了哪些节点。
 *
 * @param nodes 全部画布节点（**坐标必须是绝对坐标**：子节点的 position 是相对父节点的，
 *              调用方要先换算成绝对，见 `toAbsolute`）
 * @param frameId 画框 id
 * @param frameBox 画框的绝对外接矩形
 * @returns 应该归属该画框的节点 id（按输入顺序）
 */
export function childrenOf(nodes: CanvasNode[], frameId: string, frameBox: Rect): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.id === frameId) continue;
    if (node.type === "frame") continue; // 不允许画框互相嵌套
    const box = nodeBox(node);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (pointIn(frameBox, center)) out.push(node.id);
  }
  return out;
}

/**
 * 把节点换算成绝对坐标。
 *
 * React Flow 的子节点 `position` 是**相对父节点**的，但"谁在谁里面"这件事必须用
 * 绝对坐标算 —— 拿相对坐标去比画框，会得到荒谬的结果（子节点看起来永远在左上角附近）。
 *
 * @param node 目标节点
 * @param byId 全部节点（用于找父节点）
 * @returns 该节点的绝对位置
 */
export function toAbsolute(
  node: Pick<CanvasNode, "id" | "position" | "parentId">,
  byId: Map<string, { id: string; position: { x: number; y: number }; parentId?: string }>,
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  // 理论上只有一层（画框不嵌套），但仍按链式累加，防止历史数据里出现多级
  let guard = 0;
  while (parentId && guard < 8) {
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
    guard += 1;
  }
  return { x, y };
}

/**
 * 算出"归属调整"的结果：谁该进这个画框、谁该离开它。
 *
 * @param nodes 全部节点
 * @param frameId 画框 id
 * @returns 需要改成"属于该画框"的节点 id，以及需要解除归属的节点 id
 */
export function planAdoption(
  nodes: CanvasNode[],
  frameId: string,
): { adopt: string[]; release: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const frame = byId.get(frameId);
  if (!frame || frame.type !== "frame") return { adopt: [], release: [] };

  const framePos = toAbsolute(frame, byId);
  const frameBox: Rect = {
    x: framePos.x,
    y: framePos.y,
    width: frame.width ?? 520,
    height: frame.height ?? 380,
  };

  // 判定用绝对坐标：先把每个节点换算过去
  const absolute = nodes.map((n) => {
    const pos = toAbsolute(n, byId);
    return { ...n, position: pos } as CanvasNode;
  });

  const shouldBelong = new Set(childrenOf(absolute, frameId, frameBox));

  const adopt: string[] = [];
  const release: string[] = [];
  for (const node of nodes) {
    if (node.id === frameId || node.type === "frame") continue;
    const isChild = node.parentId === frameId;
    const should = shouldBelong.has(node.id);
    if (should && !isChild) adopt.push(node.id);
    if (!should && isChild) release.push(node.id);
  }
  return { adopt, release };
}
