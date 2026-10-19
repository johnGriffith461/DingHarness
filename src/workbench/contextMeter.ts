import { budgetOf, keepTokensFor, type ContextBudgetMode } from "@engine/runtime/budget";

/**
 * 输入区右侧的上下文压力（C2）。
 *
 * 两条硬口径（照 DSH / cc-haha）：
 * 1. **分母不许编**：模型登记过就用它的窗口推导出的保留额度；没登记就显示
 *    "窗口未知"，分母用保守默认并在 UI 上标出来。
 * 2. **实测与估算分开**：有 provider 回来的 usage 就用它并标 `provider`；
 *    没有就用字数估算并标 `estimate` —— 两个数不能混成一个。
 */

/**
 * 用量口径与 `shared/cost.ts` 的 `StepUsage` 对齐（T0/C5 的真实字段名）。
 * 不直接 import 那个类型，是为了让这个纯函数也能被 CLI/测试单独用。
 */
export type MeterUsage = { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number };

export type ContextMeter = {
  used: number;
  limit: number;
  percent: number;
  source: "provider" | "estimate";
  /** 模型没登记：分母是保守默认，不是它的真实窗口。 */
  unknownWindow: boolean;
  status: "ok" | "warn" | "full";
};

export function contextMeterOf(input: {
  modelId?: string;
  mode?: ContextBudgetMode;
  usage?: MeterUsage;
  /** 没有 usage 时的估算量（通常来自历史消息字数）。 */
  estimatedTokens: number;
  now?: number;
}): ContextMeter {
  const limit = keepTokensFor(input.modelId, input.now, input.mode);
  const budget = budgetOf(input.modelId, input.now);
  const unknownWindow = !budget.registered;
  const providerUsed =
    input.usage &&
    [input.usage.inputTokens, input.usage.cacheReadTokens, input.usage.cacheWriteTokens].some(
      (v) => typeof v === "number",
    )
      ? (input.usage.inputTokens ?? 0) + (input.usage.cacheReadTokens ?? 0) + (input.usage.cacheWriteTokens ?? 0)
      : undefined;
  const used = providerUsed ?? Math.max(0, Math.round(input.estimatedTokens));
  const percent = limit > 0 ? Math.min(999, (used / limit) * 100) : 0;
  const status: ContextMeter["status"] = percent >= 100 ? "full" : percent >= 80 ? "warn" : "ok";
  return {
    used,
    limit,
    percent,
    source: providerUsed === undefined ? "estimate" : "provider",
    unknownWindow,
    status,
  };
}

/** 显示成 `12.4k / 966k（1%）`。 */
export function formatMeter(meter: ContextMeter): string {
  const format = (value: number): string => {
    if (value < 1000) return String(value);
    const k = value / 1000;
    /* 整千不写 ".0"（20k 比 20.0k 好读）；大数也不写小数（966k） */
    return `${value >= 100_000 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
  };
  const head = `${format(meter.used)} / ${format(meter.limit)}（${Math.round(meter.percent)}%）`;
  return meter.unknownWindow ? `窗口未知 · ${head}` : head;
}
