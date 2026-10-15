import { NODE_KIND_META, type NodeKind, type CanvasNode } from "./types";

/**
 * 图层模型（阶段 8.1 / 8.2，对标原版 `data-canvas-order`、`data-canvas-slot`、
 * `aiCreation_canvas_layerContext_*`）。
 *
 * 「图层」= 画布上的一张卡片/形状/图片，按 z 序叠在一起。
 * 原版把这件事做成了设计工具里的图层面板：能选中、能显隐、能锁定、能调顺序、
 * 右键还能翻转与替换图片。这里把**可离线验证的纯逻辑**集中在本模块，
 * 面板只管画和转发 —— 顺序算错是最容易出、也最难靠肉眼发现的一类 bug。
 *
 * 顺序约定（**很重要，界面与算法都靠它**）：
 *   · 数组顺序 = 从底到顶（越靠后越在上面，React Flow 原生就是这个语义）
 *   · 面板显示 = 从顶到底（用户习惯"最上面那层排第一"）
 *   · 所以面板是数组的**倒序**，两处不要各写一套
 */

/**
 * 节点在界面上的显示标题。
 *
 * 2026-10-16：原来住在 `canvas/references.ts`（画布聊天那条 `@` 引用链上）；聊天拆掉之后
 * 只剩图层与别处要给节点起个人话名字，所以搬进这里 —— 它本来就不属于聊天。
 */
export function nodeLabel(node: Pick<CanvasNode, "id" | "type" | "data">): string {
  const data = node.data as Record<string, unknown>;
  const raw = data?.title ?? data?.alt;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  // 没标题时用「类型 + id 里的数字」兜底：带数字才能区分同类节点（代码2 / 代码3）
  const meta = NODE_KIND_META[node.type as NodeKind];
  const suffix = /^[A-Za-z]*(d+)$/.exec(node.id)?.[1] ?? node.id;
  return `${meta?.label ?? node.type}${suffix}`;
}

/** 图层调整顺序的动作（对标 `layerContext_*`）。 */
export type LayerOrderOp = "front" | "forward" | "backward" | "back";

/** 面板里一行图层。 */
export type LayerRow = {
  id: string;
  /** 显示名（节点标题，没有则用类型 + 编号）。 */
  label: string;
  /** 节点类型。 */
  kind: string;
  /** 是否隐藏。 */
  hidden: boolean;
  /** 是否锁定（锁定后不能拖动，但仍可选中查看）。 */
  locked: boolean;
  /** 是否选中。 */
  selected: boolean;
  /** z 序（从底往上的序号，0 是最底层）。 */
  order: number;
};

/** 节点是否被锁定。 */
export function isLocked(node: Pick<CanvasNode, "data">): boolean {
  return Boolean((node.data as Record<string, unknown> | undefined)?.locked);
}

/**
 * 按 z 序排出图层面板的行。
 *
 * 标题在**这里**算好（而不是留给面板）：
 * 面板只拿到行数据、拿不到节点对象，早期版本让面板自己拼名字，
 * 结果拼成了 `undefined1`（行里只有 `kind`，没有 `type`/`data`，`nodeLabel` 无从取值）。
 *
 * @param nodes 画布节点（数组顺序 = 从底到顶）
 * @returns 面板行，**从顶到底**（第一行是最上面那层）
 */
export function toLayerRows(nodes: CanvasNode[]): LayerRow[] {
  return nodes
    .map((node, index) => ({
      id: node.id,
      label: nodeLabel(node),
      kind: node.type as string,
      hidden: Boolean(node.hidden),
      locked: isLocked(node),
      selected: Boolean(node.selected),
      order: index,
    }))
    .reverse();
}

/**
 * 重排一次图层顺序。
 *
 * @param ids 当前顺序（从底到顶）
 * @param id 被操作的那一层
 * @param op front=置顶 / forward=上移一层 / backward=下移一层 / back=置底
 * @returns 新的顺序（从底到顶）；如果已经在头/尾则原样返回
 */
export function reorderLayers(ids: string[], id: string, op: LayerOrderOp): string[] {
  const from = ids.indexOf(id);
  if (from === -1) return ids;
  const next = [...ids];

  switch (op) {
    case "front": {
      if (from === ids.length - 1) return ids;
      next.splice(from, 1);
      next.push(id);
      return next;
    }
    case "back": {
      if (from === 0) return ids;
      next.splice(from, 1);
      next.unshift(id);
      return next;
    }
    case "forward": {
      if (from === ids.length - 1) return ids;
      [next[from], next[from + 1]] = [next[from + 1], next[from]];
      return next;
    }
    case "backward": {
      if (from === 0) return ids;
      [next[from], next[from - 1]] = [next[from - 1], next[from]];
      return next;
    }
  }
}

/** 该动作此刻是否可用（界面据此置灰，而不是让用户点了没反应）。 */
export function canReorder(ids: string[], id: string, op: LayerOrderOp): boolean {
  const from = ids.indexOf(id);
  if (from === -1) return false;
  switch (op) {
    case "front":
      return from !== ids.length - 1;
    case "back":
      return from !== 0;
    case "forward":
      return from !== ids.length - 1;
    case "backward":
      return from !== 0;
  }
}

/** 翻转方向（圆角矩形/图片都适用）。 */
export type FlipAxis = "horizontal" | "vertical";

/**
 * 算出翻转后的 CSS transform。
 *
 * 不清掉旧的翻转再叠加，而是**按位异或**：连点两次水平翻转应该回到原样，
 * 而不是叠成 scale(-1,-1)（那样看起来是"转了 180°"，不是"翻回来"）。
 *
 * @param current 当前 flipX / flipY
 * @param axis 这次翻转哪个轴
 * @returns 新的 flipX / flipY
 */
export function flipState(
  current: { flipX?: boolean; flipY?: boolean },
  axis: FlipAxis,
): { flipX: boolean; flipY: boolean } {
  const flipX = Boolean(current.flipX);
  const flipY = Boolean(current.flipY);
  return axis === "horizontal" ? { flipX: !flipX, flipY } : { flipX, flipY: !flipY };
}

/** 由翻转状态拼出 transform（给图片/形状用）。 */
export function flipTransform(state: { flipX?: boolean; flipY?: boolean }): string | undefined {
  const sx = state.flipX ? -1 : 1;
  const sy = state.flipY ? -1 : 1;
  if (sx === 1 && sy === 1) return undefined;
  return `scale(${sx}, ${sy})`;
}

/**
 * 支持翻转的节点类型（有画面内容才有"左/右"可言）。
 *
 * 注意形状是**两个节点类型**（`rect` / `ellipse`），不是一个叫 `shape` 的类型 ——
 * 早期这里只写了 `shape`，结果形状的"翻转"在菜单里一直是灰的（点了没反应）。
 * 加节点类型时记得同步这里。
 */
export function canFlip(kind: string): boolean {
  return kind === "image" || kind === "rect" || kind === "ellipse";
}

/** 支持"替换图片"的类型（对标 `layerContext_replaceImage`）。 */
export function canReplaceImage(kind: string): boolean {
  return kind === "image";
}

/**
 * 把顺序落到节点数组上（不改动节点对象本身，只重排）。
 *
 * @param nodes 当前节点数组（从底到顶）
 * @param order 目标顺序（节点 id，从底到顶）
 * @returns 重排后的数组；id 对不上时原样返回
 */
export function applyOrder(nodes: CanvasNode[], order: string[]): CanvasNode[] {
  if (order.length !== nodes.length) return nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: CanvasNode[] = [];
  for (const id of order) {
    const node = byId.get(id);
    if (!node) return nodes;
    out.push(node);
  }
  return out;
}
