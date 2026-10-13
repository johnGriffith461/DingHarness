import type { Marker, MarkerPoint } from "./markers";

/**
 * 标记层的纯几何：把一条标记换算成 SVG 可画的表达式。
 *
 * 单独抽出来是为了能离线单测 —— 标记好不好用全在这些数值上
 * （箭头歪了、椭圆瘪了、涂鸦点太密卡顿，都是这里的算术问题）。
 */

/** 折线路径（涂鸦 / 划重点）。 */
export function polylinePath(points: MarkerPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const p = points[0];
    // 单点也要看得见：画一个极短线段
    return `M ${p.x} ${p.y} L ${p.x + 0.01} ${p.y}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i += 1) {
    d += ` L ${points[i].x} ${points[i].y}`;
  }
  return d;
}

/** 橡皮筋式折线：相邻点之间用二阶贝塞尔，视觉更顺滑（对标原版涂鸦的圆头笔迹）。 */
export function smoothPath(points: MarkerPoint[]): string {
  if (points.length < 3) return polylinePath(points);
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    d += ` Q ${points[i].x} ${points[i].y} ${mid.x} ${mid.y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** 矩形（任意方向拖拽都归一化成 左上 + 宽高）。 */
export function rectAttrs(from: MarkerPoint, to: MarkerPoint): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** 椭圆（以拖拽矩形为外接框）。 */
export function ellipseAttrs(from: MarkerPoint, to: MarkerPoint): { cx: number; cy: number; rx: number; ry: number } {
  const box = rectAttrs(from, to);
  return {
    cx: box.x + box.width / 2,
    cy: box.y + box.height / 2,
    rx: Math.max(box.width / 2, 1),
    ry: Math.max(box.height / 2, 1),
  };
}

/**
 * 箭头。
 *
 * 本体是从起点到终点的直线；箭头头部按线宽缩放，保证细线也看得清、
 * 粗线也不至于变成一个巨大的三角。
 */
export function arrowGeometry(
  from: MarkerPoint,
  to: MarkerPoint,
  width: number,
): { line: { x1: number; y1: number; x2: number; y2: number }; head: MarkerPoint[] } {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = Math.max(10, width * 3.4);
  const spread = Math.PI / 7;
  // 头部两条边稍微往回缩，避免线宽把三角尖端顶出去
  const back = Math.min(size * 0.85, Math.hypot(to.x - from.x, to.y - from.y) * 0.5);
  return {
    line: { x1: from.x, y1: from.y, x2: to.x, y2: to.y },
    head: [
      { x: to.x - back * Math.cos(angle - spread), y: to.y - back * Math.sin(angle - spread) },
      { x: to.x, y: to.y },
      { x: to.x - back * Math.cos(angle + spread), y: to.y - back * Math.sin(angle + spread) },
    ],
  };
}

/** 遮罩区域（有轨迹就跟随轨迹包围盒，否则用拖拽矩形）。 */
export function maskAttrs(marker: Marker): { x: number; y: number; width: number; height: number } {
  return rectAttrs(marker.from, marker.to);
}

/** 文字标记的锚点：从落点往下偏移一行，避免文字压在指针位置。 */
export function textAnchor(marker: Marker): MarkerPoint {
  return marker.from;
}

/** 某条标记的 SVG 元素需要哪些属性（渲染器按 kind 分派）。 */
export function markerStrokeWidth(marker: Marker): number {
  return Math.max(1, marker.width);
}

/** 序号标记的圆圈半径（随线宽增大）。 */
export function numberBadgeRadius(marker: Marker): number {
  return Math.max(11, marker.width * 4);
}
