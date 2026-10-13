import { pointToRendererPoint, rendererPointToPoint, snapPosition } from "@xyflow/system";
import type { Transform, Viewport, XYPosition } from "@xyflow/react";

/**
 * 世界坐标 ↔ 屏幕坐标换算（对标原版 `world-point` / `viewport`）。
 *
 * 三种坐标各有一层含义，别混：
 *   · client —— 浏览器视口坐标（鼠标事件的 `clientX/clientY`）
 *   · screen —— 相对画布容器的像素坐标（client 减去容器 rect 左上角）
 *   · flow   —— 画布世界坐标（不随平移缩放变化，节点 position 用的就是这个）
 *
 * 换算与 React Flow 内部共用 `@xyflow/system` 的同一组函数，避免自己抄公式后与画布
 * 真实变换漂移。注意两者的入参形式不同：本模块对外收 `Viewport` 对象（`{x, y, zoom}`，
 * 就是 `useViewport()` 与 `onMoveEnd` 给的那只），内部再转成 xyflow 的 `Transform` 元组。
 */

/** `Viewport` 对象 → xyflow 内部使用的 `[x, y, zoom]` 元组。 */
export function toTransform(viewport: Viewport): Transform {
  return [viewport.x, viewport.y, viewport.zoom];
}

/** `[x, y, zoom]` 元组 → `Viewport` 对象（React Flow 的 store 里存的是元组）。 */
export function fromTransform(transform: Transform): Viewport {
  return { x: transform[0], y: transform[1], zoom: transform[2] };
}

/** 屏幕像素坐标 → 画布世界坐标。 */
export function screenToFlowPosition(point: XYPosition, viewport: Viewport): XYPosition {
  return pointToRendererPoint(point, toTransform(viewport));
}

/** 画布世界坐标 → 屏幕像素坐标。 */
export function flowToScreenPosition(point: XYPosition, viewport: Viewport): XYPosition {
  return rendererPointToPoint(point, toTransform(viewport));
}

/**
 * 鼠标/指针事件坐标 → 屏幕像素坐标（扣除容器在页面中的位置）。
 * 容器 rect 取不到时按 0 处理，等价于容器贴齐页面左上角。
 */
export function clientToScreenPosition(
  client: XYPosition,
  bounds: { left: number; top: number } | null,
): XYPosition {
  return { x: client.x - (bounds?.left ?? 0), y: client.y - (bounds?.top ?? 0) };
}

/** 鼠标/指针事件坐标 → 画布世界坐标（涂抹选与"在此处新建节点"都走它）。 */
export function clientToFlowPosition(
  client: XYPosition,
  bounds: { left: number; top: number } | null,
  viewport: Viewport,
): XYPosition {
  return screenToFlowPosition(clientToScreenPosition(client, bounds), viewport);
}

/** 世界坐标按网格吸附（拖动落位用）。 */
export function snapToGridPosition(point: XYPosition, grid: [number, number]): XYPosition {
  return snapPosition(point, grid);
}

export type { Viewport };
