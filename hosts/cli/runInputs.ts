import { getProvider } from "../../engine/runtime/providers";
import { keepTokensFor, parseBudgetMode } from "../../engine/runtime/budget";
import { resolveFor } from "../../engine/runtime/modelConfigResolver";
import { readModelConfig } from "../../engine/adapters/modelConfigStore";
import type { EngineRunRequest } from "../../engine/index";
import type { RuntimeModelConfig } from "../../engine/runtime/modelRuntime";
import type { ConfirmMode } from "../../shared/ipc";
import type { CliConfig } from "./config";

/**
 * **`ding run` 的请求组装**（从 `main.ts` 拆出来，2026-10-19）。
 *
 * 拆的理由是结构守卫（`main.ts` 涨到 909 行 > 900）：那里本来就是三件事混在一起 ——
 * 参数解析、请求组装、结果上屏。这里只放**请求组装**那一块，行为一字不改。
 *
 * 顺带把 T0 的模型能力解析收在这里：它属于"这一轮请求长什么样"，
 * 不属于命令行解析，也不属于上屏。
 */

/** 解析这一轮要用的模型能力（用户声明 > 内置推荐）。 */
export function resolveRuntimeModel(input: {
  providerId: string;
  model?: string;
  dataDir: string;
  fallbackModel?: string;
}): { model?: string; runtime?: RuntimeModelConfig } {
  const provider = getProvider(input.providerId);
  const model = input.model ?? input.fallbackModel ?? provider?.models[0];
  if (!provider) return { model };
  const runtime = resolveFor(
    {
      providerId: provider.id,
      modelId: model ?? "",
      baseUrl: provider.baseURL,
      apiType: provider.protocol,
    },
    readModelConfig(input.dataDir).file.rules,
  );
  return { model, runtime };
}

/** 一句能力摘要（打进 stderr 的暗色行；没声明窗口时不打印）。 */
export function describeRuntimeModel(
  model: string | undefined,
  runtime: RuntimeModelConfig | undefined,
  config: CliConfig,
): string | undefined {
  if (runtime?.contextWindow === undefined) return undefined;
  const keep = keepTokensFor(model, Date.now(), parseBudgetMode(config.contextBudget), {
    contextWindow: runtime.contextWindow,
    ...(runtime.maxOutputTokens === undefined ? {} : { maxOutputTokens: runtime.maxOutputTokens }),
  });
  return `模型能力：窗口 ${runtime.contextWindow} / 最大输出 ${runtime.maxOutputTokens ?? "未声明"} / 历史保留 ${keep}`;
}

/** 组装这一轮请求。 */
export function buildRunRequest(input: {
  sessionId: string;
  provider: string;
  model?: string;
  runtime?: RuntimeModelConfig;
  system: string;
  task: string;
  mode: ConfirmMode;
  steps: number;
  config: CliConfig;
  nextSteer: () => string[];
}): EngineRunRequest {
  return {
    sessionId: input.sessionId,
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    system: input.system,
    messages: [{ role: "user", content: input.task }],
    mode: input.mode,
    useTools: true,
    maxSteps: input.steps,
    ...(input.runtime ? { modelConfig: input.runtime } : {}),
    /* 用户声明过这个模型（runtime.manual 或有 matched）→ 允许它不在 provider 清单里 */
    ...(input.runtime?.manual ? { allowUndeclaredModel: true } : {}),
    nextSteer: input.nextSteer,
    ...(typeof input.config.maxBudgetUsd === "number" && input.config.maxBudgetUsd > 0
      ? { maxBudgetUsd: input.config.maxBudgetUsd }
      : {}),
  };
}
