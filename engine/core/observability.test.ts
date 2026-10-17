import { describe, expect, it } from "vitest";

import {
  describeObservability,
  formatMs,
  formatRate,
  percentile,
  summarizeObservability,
  type TraceLike,
} from "./observability";

/**
 * 观测汇总（L08）。
 *
 * 判据：失败按同一套词表分类、分位数不插值、没有样本给 `null`（不显示 0）。
 */

const trace = (over: Partial<TraceLike> = {}): TraceLike => ({ at: 0, ok: true, ...over });

describe("分位数", () => {
  it("最近邻（不插值）：偶数个样本给真实值", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
  });

  it("空样本给 null（不显示 0ms）", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it("坏值被忽略", () => {
    expect(percentile([Number.NaN, 5, Infinity], 0.5)).toBe(5);
  });
});

describe("汇总", () => {
  it("⭐ 成功/失败与成功率", () => {
    const got = summarizeObservability([trace(), trace(), trace({ ok: false, error: "429 rate limit" })]);
    expect(got.turns).toBe(3);
    expect(got.ok).toBe(2);
    expect(got.failed).toBe(1);
    expect(got.successRate).toBeCloseTo(2 / 3);
  });

  it("⭐ 失败按同一套词表分类（限流 vs 鉴权 vs 上下文）", () => {
    const got = summarizeObservability([
      trace({ ok: false, error: "429 too many requests" }),
      trace({ ok: false, error: "429 rate limit exceeded" }),
      trace({ ok: false, error: "401 Unauthorized" }),
      trace({ ok: false, error: "maximum context length is 8192 tokens" }),
    ]);
    const kinds = Object.fromEntries(got.failures.map((f) => [f.kind, f.count]));
    expect(kinds.rate).toBe(2);
    expect(kinds.auth).toBe(1);
    expect(kinds.context).toBe(1);
    /* 人话来自 failureMessage，不是另编一句 */
    expect(got.failures.find((f) => f.kind === "auth")?.label).toContain("密钥");
  });

  it("⭐ 工具失败率", () => {
    const got = summarizeObservability([
      trace({ toolCalls: 4, toolFailures: 1 }),
      trace({ toolCalls: 6, toolFailures: 0 }),
    ]);
    expect(got.tools).toEqual({ calls: 10, failures: 1, successRate: 0.9 });
  });

  it("没有工具调用时成功率是 null（不是 0%）", () => {
    expect(summarizeObservability([trace()]).tools.successRate).toBeNull();
  });

  it("延迟只统计有上报的轮", () => {
    const got = summarizeObservability([
      trace({ elapsedMs: 100 }),
      trace({ elapsedMs: 300 }),
      trace(),
    ]);
    expect(got.latency.samples).toBe(2);
    expect(got.latency.p50).toBe(100);
    expect(got.latency.max).toBe(300);
  });

  it("空输入：全部 null/0，不抛", () => {
    const got = summarizeObservability([]);
    expect(got.turns).toBe(0);
    expect(got.successRate).toBeNull();
    expect(got.latency.p50).toBeNull();
    expect(got.failures).toEqual([]);
  });
});

describe("展示", () => {
  it("百分比与毫秒的空值写成 -", () => {
    expect(formatRate(null)).toBe("-");
    expect(formatMs(null)).toBe("-");
    expect(formatRate(0.5)).toBe("50.0%");
    expect(formatMs(1500)).toBe("1.5s");
  });

  it("⭐ 有失败时列出原因；没失败时明说「没有失败」", () => {
    const withFail = describeObservability(summarizeObservability([trace({ ok: false, error: "429" })]));
    expect(withFail.join("\n")).toContain("触发限流");
    const noFail = describeObservability(summarizeObservability([trace()]));
    expect(noFail.join("\n")).toContain("没有失败");
  });
});
