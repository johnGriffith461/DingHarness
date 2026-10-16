/**
 * 用量的时长文案（2026-10-16 审计 P272）。
 *
 * ## 缺陷形状
 *
 * 原来是分钟与秒**各算各的**：
 *
 * ```ts
 * `时长 ${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`
 * ```
 *
 * `round` 只看秒那一半 —— 59.6 秒的取整结果是 60，于是弹层上出现 `0:60`、`1:60`
 * 这种**不存在的时间**（用户会开始怀疑整块数字的可信度，而那正是这一栏的全部价值）。
 * 正确的做法是先把**总秒数**取整，再拆成分钟与秒。
 */

/**
 * 把秒数写成 `分:秒`（秒永远是 00–59）。
 *
 * @param seconds 时长（秒，可以带小数）
 * @returns `0:00` 这种形状
 */
export function clockOf(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
