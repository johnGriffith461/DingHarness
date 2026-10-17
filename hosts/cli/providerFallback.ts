import type { Engine, EngineRunRequest, EngineRunResult } from "../../engine/index";
import { classifyFailure, retryPolicyOf } from "../../shared/errors";
import { usageTotal } from "../../shared/cost";

/**
 * **Provider 故障转移**（U15，2026-10-18）。
 *
 * ## 它做什么
 *
 * 主 provider 失败且**可重试**时，依次换成配置里的备选再跑一次。
 *
 * ## 三条安全边界（缺一条就会把"没跑成"变成"做坏了"）
 *
 * 1. **只在没有执行过任何工具时换**：这一轮已经调过 `write_file` 之类的工具，
 *    换一家重跑会把已经发生的副作用再做一遍。宁可如实报错，也不重复副作用。
 * 2. **只对可重试的失败换**：鉴权/模型名/欠费/上下文超限换谁都是同一句拒绝，
 *    重试只是多花一次钱（策略表在 `shared/errors.ts`，能单测）。
 * 3. **用户中止就停**：换一家继续跑等于对着用户干。
 *
 * 进度行（`step-finish`）与 `ding run` 原来的口径**同一条**：打到 stderr、
 * 累计 token、拿不到就不显示数字。
 */

/** 一次故障转移运行的结果。 */
export type FallbackRun = {
  outcome: EngineRunResult;
  /** 实际跑成的那一家（可能不是主 provider）。 */
  usedProvider: string;
  /** 试过哪些（按顺序；给日志/报告用）。 */
  tried: string[];
};

/**
 * 按链条跑一轮。
 *
 * @param input.engine 引擎
 * @param input.request 基础请求（`provider` 会被覆盖）
 * @param input.primary 主 provider
 * @param input.fallbacks 备选（顺序即优先级；不认识的由调用方先滤掉）
 * @param input.modelFor 第 i 家该用哪个模型（`i=0` 时可返回用户钉的那个）
 * @param input.onProgress 进度行（stderr）
 */
export async function runWithFallback(input: {
  engine: Engine;
  request: EngineRunRequest;
  primary: string;
  fallbacks: readonly string[];
  modelFor: (provider: string, index: number) => string | undefined;
  onProgress?: (event: { step?: number; totalTokens: number }) => void;
}): Promise<FallbackRun> {
  const chain = [input.primary, ...input.fallbacks.filter((id) => id !== input.primary)];
  let totalTokens = 0;
  const tried: string[] = [];
  let outcome: EngineRunResult | undefined;
  let usedProvider = input.primary;

  for (let i = 0; i < chain.length; i += 1) {
    const provider = chain[i]!;
    tried.push(provider);
    const model = input.modelFor(provider, i);
    outcome = await input.engine.run({
      ...input.request,
      provider,
      ...(model ? { model } : {}),
      onEvent: (event) => {
        if (event.type !== "step-finish") return;
        const stepTokens = usageTotal(event.usage);
        if (stepTokens !== null) totalTokens += stepTokens;
        input.onProgress?.({ ...(event.step === undefined ? {} : { step: event.step }), totalTokens });
      },
    });
    usedProvider = provider;
    if (outcome.ok || outcome.aborted) break;
    const policy = retryPolicyOf(classifyFailure(outcome.error ?? ""));
    const executed = outcome.records.some((r) => r.type === "tool-call");
    if (!chain[i + 1] || !policy.retryable || executed) break;
  }

  if (!outcome) throw new Error("故障转移链是空的（调用方至少要给主 provider）");
  return { outcome, usedProvider, tried };
}

/**
 * 要不要告诉用户"刚才换过一家"。
 *
 * @param run 结果
 * @param primary 主 provider
 */
export function failoverNote(run: FallbackRun, primary: string): string {
  if (run.usedProvider === primary) return "";
  return `（已从 ${primary} 切到 ${run.usedProvider} —— 输出里的 provider 是实际跑的那一家）`;
}
