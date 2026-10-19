import { describe, expect, it } from "vitest";

import { contextMeterOf, formatMeter } from "./contextMeter";

/**
 * C2：上下文压力口径。
 * 挡的是"给未知模型编一个 200k 分母"与"把估算当实测"。
 */

/** 2026-10-19 的时刻（预算表按时间挑版本，固定下来才可复现）。 */
const NOW = Date.parse("2026-10-19T12:00:00Z");

describe("contextMeterOf", () => {
  it("⭐ 1M 窗口 → 分母 966k（与预算表的口径一致）", () => {
    const meter = contextMeterOf({
      modelId: "deepseek-flash",
      estimatedTokens: 12_400,
      now: NOW,
    });
    expect(meter.limit).toBe(966_000);
    expect(meter.unknownWindow).toBe(false);
    expect(meter.percent).toBeCloseTo(1.28, 1);
  });

  it("未登记模型：分母 20k 并标 unknownWindow（不编真实窗口）", () => {
    const meter = contextMeterOf({ modelId: "totally-unknown-model", estimatedTokens: 1000, now: NOW });
    expect(meter.limit).toBe(20_000);
    expect(meter.unknownWindow).toBe(true);
    expect(formatMeter(meter)).toContain("窗口未知");
  });

  it("有 provider usage 时用它，并标 provider", () => {
    const meter = contextMeterOf({
      modelId: "deepseek-flash",
      usage: { inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 500 },
      estimatedTokens: 999_999,
      now: NOW,
    });
    expect(meter.used).toBe(3500);
    expect(meter.source).toBe("provider");
  });

  it("没有 usage 时用估算，并标 estimate", () => {
    const meter = contextMeterOf({
      modelId: "deepseek-flash",
      usage: {},
      estimatedTokens: 1234,
      now: NOW,
    });
    expect(meter.used).toBe(1234);
    expect(meter.source).toBe("estimate");
  });

  it(">80% 变 warn，>=100% 变 full", () => {
    const limit = 966_000;
    expect(contextMeterOf({ modelId: "deepseek-flash", estimatedTokens: limit * 0.81, now: NOW }).status).toBe("warn");
    expect(contextMeterOf({ modelId: "deepseek-flash", estimatedTokens: limit * 1.01, now: NOW }).status).toBe("full");
    expect(contextMeterOf({ modelId: "deepseek-flash", estimatedTokens: 1000, now: NOW }).status).toBe("ok");
  });
});

describe("formatMeter", () => {
  it("千位缩写成 k，百分比取整", () => {
    expect(formatMeter({ used: 12_400, limit: 966_000, percent: 1.28, source: "estimate", unknownWindow: false, status: "ok" })).toBe(
      "12.4k / 966k（1%）",
    );
  });
});
