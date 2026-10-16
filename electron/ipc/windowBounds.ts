/**
 * 窗口尺寸按屏幕可用区钳制（**审计 P63**）。
 *
 * ## 缺陷形状
 *
 * `createWindow` 写死 `width: 1440 / height: 900 / minWidth: 1024 / minHeight: 640`。
 * 910×512 DIP 的小屏上：窗口比屏幕大、底部输入区落到屏外，而 `minWidth: 1024`
 * 又**不许用户缩小到看得见**。DPI 缩放高的机器同理（DIP 视口更小）。
 *
 * 这里把"取屏幕可用区、再逐项钳制"收成一个纯函数：
 * 先 `screen.getPrimaryDisplay().workArea` 取小，再让四个数都不超过它，
 * 且保证 `minWidth <= width`、`minHeight <= height`（Electron 对窗口选项的硬要求）。
 */

/** 一个矩形的宽高（`workArea` 与期望窗口都只用得到这两个数）。 */
export type Size = { width: number; height: number };

/** 期望窗口尺寸（含最小值）。 */
export type DesiredWindowBounds = Size & { minWidth: number; minHeight: number };

/**
 * 把期望窗口钳到屏幕可用区里。
 *
 * @param workArea 屏幕可用区（`screen.getPrimaryDisplay().workArea`）
 * @param desired 期望尺寸与最小值
 * @returns 四项都被钳过的窗口选项（保证 min ≤ max）
 */
export function clampToWorkArea(workArea: Size, desired: DesiredWindowBounds): DesiredWindowBounds {
  const width = Math.max(1, Math.min(desired.width, workArea.width));
  const height = Math.max(1, Math.min(desired.height, workArea.height));
  const minWidth = Math.max(1, Math.min(desired.minWidth, workArea.width, width));
  const minHeight = Math.max(1, Math.min(desired.minHeight, workArea.height, height));
  return { width, height, minWidth, minHeight };
}
