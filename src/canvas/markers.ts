import type { XYPosition } from "@xyflow/react";
import { rectFromJourney, type Rect } from "./nodeRect";

/**
 * 标记层（阶段 5.1 / 5.2）。
 *
 * 标记是**独立于节点的一层图形**：它不改节点内容，只表达"人在这一块上留了话"。
 * 与节点的关系是"覆盖"：`markerHitsNodes` 用几何相交算出某个标记压住了哪些节点，
 * 生成时就把这些节点当作上下文（阶段 5.3「标记作为提示词」）。
 *
 * 坐标一律用画布坐标（flow position），这样平移缩放时标记跟着画布走。
 */

/** 8 种标记。 */
export const MARKER_KINDS = [
  "rect",
  "ellipse",
  "arrow",
  "scratch",
  "text",
  "number",
  "highlight",
  "mask",
] as const;

export type MarkerKind = (typeof MARKER_KINDS)[number];

export type MarkerPoint = { x: number; y: number };

/** 一条标记：起止点 + 轨迹（涂鸦用）+ 样式。 */
export type Marker = {
  id: string;
  kind: MarkerKind;
  /** 起点（画布坐标）。 */
  from: MarkerPoint;
  /** 终点（画布坐标）；文字/序号标记只用 from。 */
  to: MarkerPoint;
  /** 自由轨迹（`scratch` / `highlight` 用；其它类型为空）。 */
  trail?: MarkerPoint[];
  color: string;
  /** 线宽（画布单位）。 */
  width: number;
  /** 文字标记的内容。 */
  text?: string;
  /** 序号标记的编号。 */
  order?: number;
  /** 是否被选中。 */
  selected?: boolean;
};

export type MarkerStyle = { color: string; width: number };

/** 常用颜色（标记层用醒目的高饱和色，和节点的深色底拉开）。 */
export const MARKER_COLORS = ["#f87171", "#fbbf24", "#4ade80", "#60a5fa", "#c084fc", "#f472b6"] as const;

export const DEFAULT_MARKER_COLOR = MARKER_COLORS[0];
export const DEFAULT_MARKER_WIDTH = 3;

/** 拖拽至少要移动这么多画布单位才算一条标记（避免点击留下 0 长度的垃圾标记）。 */
export const MARKER_MIN_DRAG = 6;

/** 每种标记的提示文案（工具条 title / 状态栏）。 */
export const MARKER_KIND_META: Record<MarkerKind, { label: string; hint: string }> = {
  rect: { label: "方框", hint: "拖出矩形框，圈出一块区域" },
  ellipse: { label: "圈选", hint: "拖出椭圆形，圈住某个点" },
  arrow: { label: "箭头", hint: "从起点拖向终点，表示方向" },
  scratch: { label: "涂鸦", hint: "按住自由涂画" },
  text: { label: "批注", hint: "点一下写一句备注" },
  number: { label: "序号", hint: "点一下按顺序编号，用于列步骤" },
  highlight: { label: "划重点", hint: "按住划过，给文字划线" },
  mask: { label: "遮挡", hint: "拖出半透明遮罩，盖住不必要的内容" },
};

/** 需要拖拽的标记（其余是单击落点）。 */
export function markerNeedsDrag(kind: MarkerKind): boolean {
  return kind === "rect" || kind === "ellipse" || kind === "arrow" || kind === "scratch" || kind === "highlight" || kind === "mask";
}

/** 标记外接矩形（画布坐标）。 */
export function markerRect(marker: Marker): Rect {
  const points: MarkerPoint[] = marker.trail?.length
    ? marker.trail
    : [marker.from, marker.to];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  // 纯单击的标记（批注/序号）宽高为 0，给一点外框便于命中检测
  const pad = Math.max(marker.width, 8);
  return {
    x: left - pad,
    y: top - pad,
    width: Math.max(right - left, 1) + pad * 2,
    height: Math.max(bottom - top, 1) + pad * 2,
  };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

/**
 * 某个标记压住了哪些节点（标记作为提示词要用）。
 * @param marker 标记
 * @param rects 节点 id → 外接矩形
 * @returns 被压住的节点 id
 */
export function markerHitsNodes(marker: Marker, rects: Map<string, Rect>): string[] {
  const box = markerRect(marker);
  const hits: string[] = [];
  for (const [id, rect] of rects) {
    if (intersects(box, rect)) hits.push(id);
  }
  return hits;
}

/** 所有标记压住的节点并集（去重，保持稳定顺序）。 */
export function markersHitNodes(markers: Marker[], rects: Map<string, Rect>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const marker of markers) {
    for (const id of markerHitsNodes(marker, rects)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * 把标记转成提示词里的一段文字描述。
 *
 * 只写"人在哪儿留了什么话"——具体节点内容由 `buildSelectionContext` 负责拼，
 * 两边不要重复，否则提示词里会出现两份同样的素材。
 */
export function markersAsPrompt(
  markers: Marker[],
  rects: Map<string, Rect>,
  labelOf: (id: string) => string,
): string {
  if (markers.length === 0) return "";
  const lines: string[] = [];
  for (const marker of markers) {
    const kind = MARKER_KIND_META[marker.kind].label;
    const targets = markerHitsNodes(marker, rects).map(labelOf);
    const targetText = targets.length ? `（覆盖：${targets.join("、")}）` : "";
    const body =
      marker.text?.trim() ||
      (marker.kind === "number" ? `第 ${marker.order ?? 0} 个要处理的地方` : "");
    lines.push(`- ${kind}${targetText}${body ? `：${body}` : ""}`);
  }
  return lines.join("\n");
}

/** 生成一个标记 id。 */
export function nextMarkerId(markers: Marker[]): string {
  let max = 0;
  for (const marker of markers) {
    const match = /^m(\d+)$/.exec(marker.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `m${max + 1}`;
}

/** 下一个序号标记的编号。 */
export function nextMarkerOrder(markers: Marker[]): number {
  return markers.filter((m) => m.kind === "number").length + 1;
}

/** 制造一条标记（默认样式 + 从当前工具继承的样式）。 */
export function makeMarker(
  id: string,
  kind: MarkerKind,
  from: MarkerPoint,
  to: MarkerPoint,
  style: MarkerStyle,
  extra?: { trail?: MarkerPoint[]; text?: string; order?: number },
): Marker {
  return {
    id,
    kind,
    from,
    to,
    color: style.color,
    width: style.width,
    ...extra,
  };
}

/** 把一次拖拽换算成矩形两条对角点（支持任意方向拖拽）。 */
export function normalizeDrag(from: MarkerPoint, to: MarkerPoint): { from: MarkerPoint; to: MarkerPoint } {
  return { from, to };
}

/** 由轨迹点算出外接矩形（涂鸦用）。 */
export function trailRect(trail: MarkerPoint[]): Rect {
  return rectFromJourney(trail[0] ?? { x: 0, y: 0 }, trail[trail.length - 1] ?? { x: 0, y: 0 });
}

/** 判断轨迹是否够长（涂鸦/划重点）。 */
export function trailLongEnough(trail: MarkerPoint[], min = MARKER_MIN_DRAG): boolean {
  if (trail.length < 2) return false;
  let length = 0;
  for (let i = 1; i < trail.length; i += 1) {
    const dx = trail[i].x - trail[i - 1].x;
    const dy = trail[i].y - trail[i - 1].y;
    length += Math.hypot(dx, dy);
  }
  return length >= min;
}

/** 拖拽是否够长（矩形/椭圆/箭头/遮罩）。 */
export function dragLongEnough(from: MarkerPoint, to: MarkerPoint, min = MARKER_MIN_DRAG): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= min;
}

export type { XYPosition };

/**
 * 把标记并进用户的要求里（阶段 5.3「标记当提示词」）。
 *
 * **为什么在这里**（2026-10-14 从 `CanvasRuntime.tsx` 搬过来）：
 * 这段逻辑以前只能靠"跑起来、点生成、从一个 DEV-only 的 `window.__lastAiPrompt`
 * 里读请求文本"来验 —— 而那个探针打包后就没了，于是那条脚本**永远跑不了**、
 * 这个功能等于没人守。（那条脚本 2026-10-16 已按退役处理从盘上删掉，
 * 这里不再点名它：点一个不存在的判据，只会让下一个人以为还有人在盯着。）
 * 搬进纯模块之后，同一件事由单测钉住（`markers.test.ts`，界面那条是 `accept-p5.mjs`）：
 * 不连模型、不看探针。
 *
 * 依赖方向也顺手正过来了：这里**不认识** store、也不认识节点类型表 ——
 * 节点怎么称呼由调用方给（`labelOf`），画布以外的东西一律不进来。
 *
 * 只在开关打开、且确实有标记时才拼这一段；否则原样返回用户输入 ——
 * 不该因为"画布上有标记"就悄悄改变没打开这个功能的人看到的结果。
 *
 * @param store 当前画布状态（只要有标记与节点的位置/尺寸）
 * @param enabled 是否把标记当提示词
 * @param instruction 用户原本输入的要求
 * @param labelOf 某个节点在提示词里怎么写（如 `n1(文本)`）；不传就只写 id
 * @returns 附加了标记描述的要求
 */
export function instructionFromMarkers(
  store: {
    markers: Marker[];
    nodes: { id: string; position: XYPosition; width?: number | null; height?: number | null }[];
  },
  enabled: boolean,
  instruction: string,
  labelOf: (id: string) => string = (id) => id,
): string {
  if (!enabled || store.markers.length === 0) return instruction;
  const rects = new Map<string, Rect>();
  for (const node of store.nodes) {
    rects.set(node.id, {
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? 300,
      height: node.height ?? 200,
    });
  }
  const marks = markersAsPrompt(store.markers, rects, labelOf);
  if (!marks) return instruction;
  return `${instruction}\n\n【画布标记】\n${marks}`;
}
