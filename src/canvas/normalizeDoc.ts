import type { Edge } from "@xyflow/react";
import type { CanvasNode } from "./types";
import { MARKER_KINDS, type Marker, type MarkerKind } from "./markers";

/**
 * 从落盘的（不可信）数据里恢复画布文档（§181）。
 *
 * ## 为什么必须做
 *
 * 加载画布时原来是**一路裸断言**：
 *
 * ```ts
 * nodes: doc.nodes as CanvasNode[],
 * edges: doc.edges as never[],
 * markers: (doc.markers ?? []) as Marker[],
 * ```
 *
 * 画布是整个应用里**最复杂的一块**（10 种节点、连线、标注、版本）。
 * 一个手改过的 / 旧版本的 `document.json`（节点缺 `position`、
 * 连线指向一个不存在的节点）会直接进到 react-flow 里：
 * **轻则渲染出一堆烂节点，重则整块画布打不开** —— 而这是用户创作的地方。
 *
 * ## 取舍（关键那条：**宁可挪位置，不可丢内容**）
 *
 * | 情况 | 处理 | 为什么 |
 * |---|---|---|
 * | 节点缺 `position` | **挪到 (0,0)** | 位置是布局，内容是用户的活 —— **不能因为布局坏了就把内容丢了** |
 * | 节点缺 `id` / 类型不认识 | 丢掉 | 没有 id 管不了；类型不认识**没有对应的渲染组件**（渲染必炸） |
 * | 连线两端有一个不在 | 丢掉 | react-flow 对**悬空连线**会报错 |
 * | 标注形状不对 | 丢掉 | 只是标记，不影响内容 |
 * | `viewport` / `revision` 坏了 | 给默认值 | 视图位置坏了不该影响内容 |
 *
 * @param raw 落盘的文档（不可信）
 * @returns 洗过的文档片段（`nodes` / `edges` / `markers` / `viewport` / `revision`）
 */
export type NormalizedCanvas = {
  nodes: CanvasNode[];
  edges: Edge[];
  markers: Marker[];
  viewport: { x: number; y: number; zoom: number };
  revision: number;
  /** 丢掉了多少条（如实告诉用户"有些东西没读进来"，而不是静默吞掉） */
  dropped: { nodes: number; edges: number; markers: number };
};

/** 认得的节点类型（与 `nodeTypes` 里注册的渲染组件一一对应）。 */
export const KNOWN_NODE_TYPES = [
  "markdown",
  "code",
  "image",
  "mindmap",
  "mermaid",
  "whiteboard",
  "rect",
  "ellipse",
  "frame",
  "html",
] as const;

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * 洗一份画布文档。
 *
 * @param raw 落盘的文档（任意形状）
 * @returns 洗过的结果；`dropped` 里如实报丢了几条
 */
export function normalizeCanvasDoc(raw: unknown): NormalizedCanvas {
  const doc = (raw ?? {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const rawEdges = Array.isArray(doc.edges) ? doc.edges : [];
  const rawMarkers = Array.isArray(doc.markers) ? doc.markers : [];

  const nodes: CanvasNode[] = [];
  const ids = new Set<string>();
  for (const item of rawNodes) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id : "";
    const type = n.type as CanvasNode["type"];
    if (!id || ids.has(id)) continue;
    if (!(KNOWN_NODE_TYPES as readonly string[]).includes(type)) continue;
    ids.add(id);

    const pos = (n.position ?? {}) as Record<string, unknown>;
    /*
     * ⭐ 位置坏了就挪到原点，**不丢内容**：位置是布局，内容是用户的活。
     * （react-flow 要求节点必须有 position —— 缺了会直接报错。）
     */
    const position = { x: isFiniteNum(pos.x) ? pos.x : 0, y: isFiniteNum(pos.y) ? pos.y : 0 };
    const data = n.data && typeof n.data === "object" ? n.data : {};
    nodes.push({ ...(n as object), id, type, position, data } as unknown as CanvasNode);
  }

  const edges: Edge[] = [];
  for (const item of rawEdges) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    const source = typeof e.source === "string" ? e.source : "";
    const target = typeof e.target === "string" ? e.target : "";
    if (!id || !source || !target) continue;
    // ⭐ 悬空连线必须丢掉：react-flow 会因为它报错
    if (!ids.has(source) || !ids.has(target)) continue;
    edges.push({ ...(e as object), id, source, target } as unknown as Edge);
  }

  const markers: Marker[] = [];
  const asPoint = (v: unknown): { x: number; y: number } | null => {
    if (!v || typeof v !== "object") return null;
    const p = v as { x?: unknown; y?: unknown };
    return isFiniteNum(p.x) && isFiniteNum(p.y) ? { x: p.x, y: p.y } : null;
  };
  const asPointList = (v: unknown): { x: number; y: number }[] =>
    Array.isArray(v) ? v.map(asPoint).filter((p): p is { x: number; y: number } => p !== null) : [];

  for (const item of rawMarkers) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id : "";
    const kind = m.kind as MarkerKind;
    if (!id || !(MARKER_KINDS as readonly string[]).includes(kind)) continue;
    /*
     * ⚠️⚠️ **这里原来是按 `points` 判的 —— 而写出去的是 `from` / `to`**（2026-10-16 修，审计 P28 同族）。
     *
     * 代价实测到了（`accept-p5` 的三处读数 + 渲染层日志）：
     * 应用自己写出去的标记长这样 `{id, kind, from, to, color, width}`（见 `Marker` 类型），
     * 而这里找的是 `points` —— 于是**每一条都被判成"没有点"丢掉**。
     * 后果不是"少画几笔"：载入时全丢 → 紧接着自动保存把空集合写回去（revision 还 +1），
     * **用户画的所有批注在重启后消失，而且盘上那份也被覆盖了**（只剩历史 `rev-*.json` 里还有）。
     *
     * 读的人和写的人对同一个东西的两套理解 —— 这就是它为什么静默：
     * 单测当时也在按 `points` 写用例（见 `normalizeDoc.test.ts`），所以两边自洽、只有产品是坏的。
     *
     * 现在：**以真实形状（`from`/`to`）为准**；顺手兼容 `points`（早期若写过这种文档，别丢内容）。
     * `trail` 也照样洗（涂鸦那一笔的轨迹）。
     */
    const from = asPoint(m.from) ?? asPointList(m.points)[0] ?? null;
    const to = asPoint(m.to) ?? (asPointList(m.points).length > 0 ? asPointList(m.points)[asPointList(m.points).length - 1]! : null);
    if (!from || !to) continue;
    const trail = asPointList(m.trail);
    markers.push({
      ...(m as object),
      id,
      kind,
      from,
      to,
      ...(trail.length ? { trail } : {}),
    } as unknown as Marker);
  }

  const vp = (doc.viewport ?? {}) as Record<string, unknown>;
  const zoom = isFiniteNum(vp.zoom) && vp.zoom > 0 ? vp.zoom : 1;

  return {
    nodes,
    edges,
    markers,
    viewport: { x: isFiniteNum(vp.x) ? vp.x : 0, y: isFiniteNum(vp.y) ? vp.y : 0, zoom },
    revision: isFiniteNum(doc.revision) && doc.revision > 0 ? Math.floor(doc.revision) : 0,
    dropped: {
      nodes: rawNodes.length - nodes.length,
      edges: rawEdges.length - edges.length,
      markers: rawMarkers.length - markers.length,
    },
  };
}

/**
 * 有没有丢东西（界面据此说一句）。
 *
 * @param result 洗过的结果
 * @returns 丢掉的总条数
 */
export function droppedCount(result: Pick<NormalizedCanvas, "dropped">): number {
  return result.dropped.nodes + result.dropped.edges + result.dropped.markers;
}
