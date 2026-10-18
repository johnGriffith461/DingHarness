import { MODEL_CATALOG, type ModelSpec } from "./models";
import {
  TEXT_ONLY_INPUT,
  resolveModelConfig,
  type ModelConfigPatch,
  type ModelConfigRule,
  type ResolvedModelConfig,
} from "./modelConfig";

/**
 * **模型配置的规则来源与解析**（T0）。
 *
 * 三处规则，按顺序叠：
 *
 * 1. **内置推荐**：从 `MODEL_CATALOG` 派生（`model` 规则）+ 一张**有依据的**
 *    中转/本地端点表（`provider-site` 规则）。没有依据的不写 —— 猜出来的窗口
 *    会让预算算错，而那种错没有任何东西会报。
 * 2. **用户规则**：用户自己加的（`models.json`）。通常是 `exact`，也允许
 *    写 `model` / `provider-site` 这种批量规则。
 * 3. 解析顺序由 `RULE_ORDER` 固定，**不由文件里的先后决定**
 *    （否则"谁后写谁赢"会让同一份配置在两次保存后行为不同）。
 */

/** 正则转义：把模型 id 当字面量整串匹配。 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把目录表里的一条转成 `model` 规则。
 *
 * @param spec 目录条目
 */
function ruleFromSpec(spec: ModelSpec): ModelConfigRule {
  const config: ModelConfigPatch = {
    properties: {
      contextWindow: spec.contextWindow,
      supportsToolCall: spec.capabilities.toolCall,
      ...(spec.capabilities.reasoning === undefined
        ? {}
        : { supportsMidConversationSystem: null }), // 推理能力不等于"支持对话中系统消息"，不推断
      inputFormat: {
        supportsText: true,
        supportsImage: spec.capabilities.attachment === true,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: spec.capabilities.attachment === true,
      },
    },
  };
  return {
    type: "model",
    modelMatch: escapeRegex(spec.id),
    config,
    note: `目录：${spec.provider}（${spec.verifiedAt}）`,
  };
}

/**
 * 常见中转/本地端点的**有依据**推荐。
 *
 * ⚠️ 这里只写"能说清依据"的：tokenrhythm 的 1M 是 2026-10-19 从它自己的
 * `/v1/models` 查到的（`context_length: 1000000`），不是猜的。
 * 本地推理（Ollama / vLLM / LM Studio）不预设窗口 —— 各家跑什么模型由用户决定，
 * 我们**不替它编一个数**。
 */
const SITE_RULES: readonly ModelConfigRule[] = [
  {
    type: "provider-site",
    modelMatch: ".*",
    baseUrlMatch: escapeRegex("https://tokenrhythm.studio/v1"),
    config: {
      properties: {
        contextWindow: 1_000_000,
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
      },
    },
    note: "tokenrhythm /v1/models 标 context_length=1000000（2026-10-19 查得）",
  },
];

/** 内置规则（目录派生 + 站点推荐）。 */
export function builtinModelConfigRules(): ModelConfigRule[] {
  return [...MODEL_CATALOG.map(ruleFromSpec), ...SITE_RULES];
}

/**
 * 解析某一条 provider+model 的配置。
 *
 * @param input provider/model/baseUrl/apiType
 * @param userRules 用户规则（`models.json` 里的）。空数组 = 纯推荐
 */
export function resolveFor(
  input: { providerId: string; modelId: string; baseUrl?: string; apiType?: string },
  userRules: readonly ModelConfigRule[] = [],
): ResolvedModelConfig {
  return resolveModelConfig([...builtinModelConfigRules(), ...userRules], {
    ...input,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.apiType === undefined ? {} : { apiType: input.apiType }),
  });
}

/**
 * 只解析**用户规则**（不含内置推荐）。
 *
 * 界面要区分"这一项是我手动改的"与"这一项来自推荐"。拿这个跟
 * `resolveFor` 的结果对比就知道哪些是 override。
 */
export function resolveUserOnly(
  input: { providerId: string; modelId: string; baseUrl?: string; apiType?: string },
  userRules: readonly ModelConfigRule[] = [],
): ResolvedModelConfig {
  return resolveModelConfig(userRules, {
    ...input,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.apiType === undefined ? {} : { apiType: input.apiType }),
  });
}

/** 一条配置的来源说明（界面"已匹配到智能配置"那一行）。 */
export function configSourceLabel(config: ResolvedModelConfig): string {
  if (config.manual) return "手动配置（覆盖推荐）";
  const notes = config.matched.map((m) => m.note).filter((n): n is string => Boolean(n));
  if (notes.length) return `智能配置：${notes.join("；")}`;
  if (config.matched.length) return "智能配置：内置推荐";
  return "无配置（未登记：按保守默认）";
}

/** 纯文本模型的最小声明（`ding models add` 没给模态时用）。 */
export const DEFAULT_INPUT_FORMAT = TEXT_ONLY_INPUT;
