import { classifyFailure, failureMessage, type FailureKind } from "../../shared/errors";

/**
 * **观测汇总**（L08，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 界面上已经有"用量"与"逐轮追踪"，但没有回答最要紧的三个问题：
 * **失败多不多、为什么失败、工具靠不靠得住**。用户只能一条条翻追踪记录。
 *
 * 这个模块把逐轮追踪压成一块看板数据（纯函数，可单测）：
 * - 轮次 / 成功率 / 失败按**原因分类**（用 `shared/errors.ts` 的同一套词表）；
 * - 工具调用次数与失败率；
 * - 延迟分位（p50 / p95 / 最大）—— 只统计**有 provider 耗时上报**的轮（不编）。
 *
 * ## 口径
 *
 * - 失败原因用 `classifyFailure`（与错误话术同一份），不另造分类；
 * - 分位数用**最近邻**（不插值）：样本少时插值会给出一个没人经历过的数；
 * - 没有样本就说 `null`，不显示 0ms（那会让人以为很快）。
 */

/** 一条追踪记录（与 `TurnTraceView` 同形；只取这里要用的字段）。 */
export type TraceLike = {
  at: number;
  ok: boolean;
  elapsedMs?: number;
  input?: number;
  output?: number;
  toolCalls?: number;
  toolFailures?: number;
  error?: string;
};

/** 一种失败原因的统计。 */
export type FailureBucket = {
  kind: FailureKind;
  /** 人话（与错误卡片同一句话）。 */
  label: string;
  count: number;
};

/** 汇总结果。 */
export type Observability = {
  turns: number;
  ok: number;
  failed: number;
  /** 成功率（0–1）；没有轮次给 null。 */
  successRate: number | null;
  failures: FailureBucket[];
  tools: { calls: number; failures: number; successRate: number | null };
  latency: { samples: number; p50: number | null; p95: number | null; max: number | null };
  tokens: { input: number; output: number };
};

/** 最近邻分位（`p` 取 0–1）。 */
export function percentile(values: readonly number[], p: number): number | null {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const index = Math.min(nums.length - 1, Math.ceil(clamped * nums.length) - 1);
  return nums[Math.max(0, index)] ?? null;
}

/**
 * 汇总一批追踪记录。
 *
 * @param traces 追踪（顺序无关）
 */
export function summarizeObservability(traces: readonly TraceLike[]): Observability {
  const turns = traces.length;
  const ok = traces.filter((t) => t.ok).length;
  const failed = turns - ok;

  const counts = new Map<FailureKind, number>();
  for (const trace of traces) {
    if (trace.ok) continue;
    const kind = classifyFailure(trace.error ?? "");
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const failures: FailureBucket[] = [...counts.entries()]
    .map(([kind, count]) => ({ kind, label: failureMessage(kind) || "原因不明", count }))
    .sort((a, b) => b.count - a.count);

  const calls = traces.reduce((sum, t) => sum + (t.toolCalls ?? 0), 0);
  const toolFailures = traces.reduce((sum, t) => sum + (t.toolFailures ?? 0), 0);
  const toolRate = calls > 0 ? Math.max(0, (calls - toolFailures) / calls) : null;

  const latencies = traces.map((t) => t.elapsedMs).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const tokens = traces.reduce(
    (acc, t) => ({ input: acc.input + (t.input ?? 0), output: acc.output + (t.output ?? 0) }),
    { input: 0, output: 0 },
  );

  return {
    turns,
    ok,
    failed,
    successRate: turns > 0 ? ok / turns : null,
    failures,
    tools: { calls, failures: toolFailures, successRate: toolRate },
    latency: {
      samples: latencies.length,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    tokens,
  };
}

/** 百分比（`null` → `-`，不写成 0%）。 */
export function formatRate(rate: number | null): string {
  return rate === null ? "-" : `${(rate * 100).toFixed(1)}%`;
}

/** 毫秒（`null` → `-`）。 */
export function formatMs(ms: number | null): string {
  if (ms === null) return "-";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** 一块可以整段打印/显示的看板文字。 */
export function describeObservability(o: Observability): string[] {
  const lines = [
    `轮次：${o.turns}（成功 ${o.ok} / 失败 ${o.failed}，成功率 ${formatRate(o.successRate)}）`,
    `工具：调用 ${o.tools.calls} 次，失败 ${o.tools.failures} 次（成功率 ${formatRate(o.tools.successRate)}）`,
    `延迟：p50 ${formatMs(o.latency.p50)} / p95 ${formatMs(o.latency.p95)} / 最慢 ${formatMs(o.latency.max)}（${o.latency.samples} 个样本）`,
    `用量：输入 ${o.tokens.input.toLocaleString("en-US")} / 输出 ${o.tokens.output.toLocaleString("en-US")} token`,
  ];
  if (o.failures.length) {
    lines.push("失败原因：");
    for (const f of o.failures) lines.push(`  · ${f.label}：${f.count} 次`);
  } else if (o.turns > 0) {
    lines.push("失败原因：（这段时间没有失败）");
  }
  return lines;
}
