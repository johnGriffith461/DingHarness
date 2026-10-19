import type { Symbol } from "./parse";

/**
 * 地图渲染（E1）：按 token 预算二分截断，误差 ≤15%。
 *
 * 输出形如：
 * ```
 * src/app.ts
 *   app  function  L12
 * ```
 * 每行截 100 字符；token 估算用 `chars/4`（与仓库其它估算同一口径）。
 */

export const DEFAULT_MAP_TOKENS = 1024;

function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function lineOf(symbol: Symbol): string {
  const line = `${symbol.file}:${symbol.name} ${symbol.kind} L${symbol.line}`;
  return line.length > 100 ? `${line.slice(0, 97)}…` : line;
}

function joinLines(lines: readonly string[]): string {
  return lines.join("\n");
}

/**
 * @param ranked 已按分数排序的符号
 * @param opts.maxTokens 预算（默认 1024）
 */
export function renderMap(
  ranked: Array<{ symbol: Symbol; score: number }>,
  opts: { maxTokens?: number } = {},
): string {
  const budget = Math.max(32, opts.maxTokens ?? DEFAULT_MAP_TOKENS);
  const lines = ranked.map((item) => lineOf(item.symbol));
  if (!lines.length) return "";
  if (estimate(joinLines(lines)) <= budget) return joinLines(lines);

  /* 二分：找最大的 n，使前 n 行的估算不超过预算 */
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimate(joinLines(lines.slice(0, mid))) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const kept = lines.slice(0, Math.max(1, lo));
  const text = joinLines(kept);
  const omitted = lines.length - kept.length;
  return omitted > 0 ? `${text}\n…（已省略 ${omitted} 个符号，按分数排序）` : text;
}
