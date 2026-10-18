import { validateOptionMap as validateMapText } from "./modelOptionMap";

/**
 * **模型能力表单**（T0，2026-10-19）：用户自己声明模型的窗口、输出上限、模态与能力。
 *
 * ## 为什么要有它（产品缺口，不是"加个字段"）
 *
 * 以前只有仓库里那张 `MODEL_CATALOG` 说了算：用户接一个新中转站的模型，
 * 我们没登记 → 走 20k 保守默认 → 1M 窗口的模型也只用 2%。
 * 用户能看见"未登记"，但**没有任何办法改**。
 *
 * 现在用户可以自己声明，而声明的东西会真的进请求：
 * 窗口进预算、输出上限进 `maxOutputTokens`、推理档位进参数映射。
 *
 *
 * - `undefined` = **继承**上一层（推荐值/内置规则）；
 * - `null` = **显式清空**（用户确实不想有这个值）；
 * - 对象逐字段递归，数组整体替换（不做元素级合并 —— 那会让"删掉一个推理档位"变成猜谜）。
 *
 * 混成一个会让"跟随推荐"永远失效。
 */

/** 一张输入模态表。`supportsText` 恒为真（纯文本模型是下限，不是选项）。 */
export type ModelInputFormat = {
  supportsText: boolean;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsAudio: boolean;
  supportsPdf: boolean;
};

/** 完整的能力声明（解析后的形态，字段都齐）。 */
export type ModelProperties = {
  requiresMfjsToolSchema: boolean;
  contextWindow: number;
  inputFormat: ModelInputFormat;
  outputFormat: { supportsText: boolean };
  supportsToolCall: boolean;
  supportsJsonSchemaOutput: boolean;
  supportsNativeWebSearch: boolean;
  supportsMidConversationSystem: boolean;
};

/** 参数的取值域与映射（`map` 是受限 CEL，见 `modelOptionMap/`）。 */
export type ModelOptionSpecs = {
  reasoningLevel: { values: string[]; map: string };
  maxOutputTokens: { max: number; map: string };
};

/** 完整配置。 */
export type ModelConfig = {
  enabled: boolean;
  properties: ModelProperties;
  optionSpecs: ModelOptionSpecs;
};

/**
 * 稀疏补丁：每个叶子可缺省（继承）或 `null`（清空）。
 *
 * 用显式的递归类型而不是 `Partial<...>`：`Partial` 只覆盖第一层，
 * 而这里要能写出「只改 inputFormat.supportsImage」这种补丁。
 */
export type ModelConfigPatch = {
  enabled?: boolean | null;
  properties?: {
    requiresMfjsToolSchema?: boolean | null;
    contextWindow?: number | null;
    inputFormat?:
      | {
          supportsText?: boolean | null;
          supportsImage?: boolean | null;
          supportsVideo?: boolean | null;
          supportsAudio?: boolean | null;
          supportsPdf?: boolean | null;
        }
      | null;
    outputFormat?: { supportsText?: boolean | null } | null;
    supportsToolCall?: boolean | null;
    supportsJsonSchemaOutput?: boolean | null;
    supportsNativeWebSearch?: boolean | null;
    supportsMidConversationSystem?: boolean | null;
  } | null;
  optionSpecs?: {
    reasoningLevel?: { values?: string[] | null; map?: string | null } | null;
    maxOutputTokens?: { max?: number | null; map?: string | null } | null;
  } | null;
};

/** 一条规则。`exact` 是用户自己加的；前三类是内置推荐。 */
export type ModelConfigRule =
  | { type: "model"; modelMatch: string; config: ModelConfigPatch; note?: string }
  | { type: "model-api"; modelMatch: string; apiTypeMatch: string; config: ModelConfigPatch; note?: string }
  | {
      type: "provider-site";
      modelMatch: string;
      baseUrlMatch: string;
      apiTypeMatch?: string;
      config: ModelConfigPatch;
      note?: string;
    }
  | {
      type: "exact";
      providerId: string;
      modelId: string;
      config: ModelConfigPatch;
      manual: boolean;
      note?: string;
    };

/** 规则的**应用顺序**：从最宽泛到最精确，后者覆盖前者。 */
export const RULE_ORDER = ["model", "model-api", "provider-site", "exact"] as const;

/** 默认的输入模态（纯文本）。 */
export const TEXT_ONLY_INPUT: ModelInputFormat = {
  supportsText: true,
  supportsImage: false,
  supportsVideo: false,
  supportsAudio: false,
  supportsPdf: false,
};

/**
 * 递归覆盖：`patch` 的 `undefined` 保持 `base`，`null` 落成 `null`（清空）。
 *
 * @param base 底层值
 * @param patch 上层补丁
 */
export function overlayValue<T>(base: T | undefined, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (patch === null) return null;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch;
  const baseObject =
    base !== undefined && base !== null && typeof base === "object" && !Array.isArray(base)
      ? (base as Record<string, unknown>)
      : {};
  const patchObject = patch as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(baseObject), ...Object.keys(patchObject)])) {
    const merged = overlayValue(baseObject[key], patchObject[key]);
    if (merged !== undefined) result[key] = merged;
  }
  return result;
}

/** 把一条补丁叠到另一条补丁上（用于规则链）。 */
export function overlayPatch(base: ModelConfigPatch, patch: ModelConfigPatch): ModelConfigPatch {
  return overlayValue(base, patch) as ModelConfigPatch;
}

/** 正则整串锚定：`modelMatch` 是"整串匹配"，不是"包含"。 */
export function anchoredMatch(value: string, pattern: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(value);
  } catch {
    /* 写坏的正则**不匹配任何东西**：宁可漏一条推荐，也不要让它匹配到全部 */
    return false;
  }
}

/** baseURL 的规范化：去尾斜杠，再比。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** 这条规则是否命中（provider/model/baseUrl/apiType）。 */
export function ruleMatches(
  rule: ModelConfigRule,
  input: { providerId: string; modelId: string; baseUrl?: string; apiType?: string },
): boolean {
  switch (rule.type) {
    case "model":
      return anchoredMatch(input.modelId, rule.modelMatch);
    case "model-api":
      return (
        anchoredMatch(input.modelId, rule.modelMatch) &&
        anchoredMatch(input.apiType ?? "", rule.apiTypeMatch)
      );
    case "provider-site": {
      const base = normalizeBaseUrl(input.baseUrl ?? "");
      if (!anchoredMatch(input.modelId, rule.modelMatch)) return false;
      if (!anchoredMatch(base, rule.baseUrlMatch)) return false;
      if (rule.apiTypeMatch !== undefined && !anchoredMatch(input.apiType ?? "", rule.apiTypeMatch)) {
        return false;
      }
      return true;
    }
    case "exact":
      return rule.providerId === input.providerId && rule.modelId === input.modelId;
  }
}

/** 解析出来的**扁平视图**（运行时只关心这几项，不该去翻嵌套）。 */
export type ResolvedModelConfig = {
  enabled: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningLevels: string[];
  reasoningMap?: string;
  maxOutputMap?: string;
  inputFormat: ModelInputFormat;
  outputFormat: { supportsText: boolean };
  supportsToolCall: boolean;
  supportsJsonSchemaOutput: boolean;
  supportsNativeWebSearch: boolean;
  supportsMidConversationSystem: boolean;
  requiresMfjsToolSchema: boolean;
  /** 命中的规则（按应用顺序），给界面显示"已匹配到智能配置"。 */
  matched: { kind: ModelConfigRule["type"]; note?: string }[];
  /** 用户是否手动改过（有 `exact` 且 `manual: true` 命中）。 */
  manual: boolean;
};

/** 把一个可能为 `null`（被清空）的布尔字段收窄成布尔。 */
function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 按顺序解析规则，产出扁平视图。
 *
 * ⚠️ **顺序是契约**：`model` → `model-api` → `provider-site` → `exact`。
 * 写反了会得到"用户手动值被内置推荐覆盖"这种谁都想不通的行为。
 *
 * @param rules 全部规则（内置在前，用户在后也可以 —— 这里按 `type` 分桶后统一排序）
 * @param input provider/model/baseUrl/apiType
 */
export function resolveModelConfig(
  rules: readonly ModelConfigRule[],
  input: { providerId: string; modelId: string; baseUrl?: string; apiType?: string },
): ResolvedModelConfig {
  const matched: { kind: ModelConfigRule["type"]; note?: string }[] = [];
  let accumulated: unknown = {};
  let manual = false;

  for (const kind of RULE_ORDER) {
    for (const rule of rules) {
      if (rule.type !== kind) continue;
      if (!ruleMatches(rule, input)) continue;
      accumulated = overlayValue(accumulated, rule.config);
      matched.push({ kind: rule.type, ...(rule.note === undefined ? {} : { note: rule.note }) });
      if (rule.type === "exact" && rule.manual) manual = true;
    }
  }

  const patch = accumulated as ModelConfigPatch;
  const properties = (patch.properties ?? {}) as NonNullable<ModelConfigPatch["properties"]>;
  const optionSpecs = (patch.optionSpecs ?? {}) as NonNullable<ModelConfigPatch["optionSpecs"]>;
  const inputFormatPatch = (properties.inputFormat ?? {}) as Partial<ModelInputFormat>;
  const reasoning = optionSpecs.reasoningLevel ?? {};
  const maxOutput = optionSpecs.maxOutputTokens ?? {};

  /*
   * `null` 在解析结果里的意思是"用户明确清空了这个字段"。
   * 对必填项（窗口/输出上限）清空等于"没有值"，调用方要走保守默认 —— 所以这里给 undefined。
   */
  const contextWindow =
    typeof properties.contextWindow === "number" && properties.contextWindow > 0
      ? properties.contextWindow
      : undefined;
  const maxOutputTokens =
    typeof maxOutput.max === "number" && maxOutput.max > 0 ? maxOutput.max : undefined;
  const reasoningLevels = Array.isArray(reasoning.values)
    ? reasoning.values.filter((v): v is string => typeof v === "string")
    : [];

  return {
    enabled: boolOr(patch.enabled, true),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    reasoningLevels,
    ...(typeof reasoning.map === "string" && reasoning.map ? { reasoningMap: reasoning.map } : {}),
    ...(typeof maxOutput.map === "string" && maxOutput.map ? { maxOutputMap: maxOutput.map } : {}),
    inputFormat: {
      supportsText: true,
      supportsImage: boolOr(inputFormatPatch.supportsImage, false),
      supportsVideo: boolOr(inputFormatPatch.supportsVideo, false),
      supportsAudio: boolOr(inputFormatPatch.supportsAudio, false),
      supportsPdf: boolOr(inputFormatPatch.supportsPdf, false),
    },
    outputFormat: { supportsText: true },
    supportsToolCall: boolOr(properties.supportsToolCall, true),
    supportsJsonSchemaOutput: boolOr(properties.supportsJsonSchemaOutput, false),
    supportsNativeWebSearch: boolOr(properties.supportsNativeWebSearch, false),
    supportsMidConversationSystem: boolOr(properties.supportsMidConversationSystem, false),
    requiresMfjsToolSchema: boolOr(properties.requiresMfjsToolSchema, false),
    matched,
    manual,
  };
}

/**
 * 校验一段参数映射能不能用，且**不许改坏请求结构**。
 *
 * 映射本身是**声明式**的（见 `modelOptionMap.ts`）：占位符 + 可选的条件规则表，
 * 没有任何可执行代码。所以这里要验的只有三件事：
 * 是不是合法 JSON、试算结果非空、有没有碰保留键。
 *
 * @returns 错误消息（`null` = 通过）
 */
export function validateOptionMap(source: string): string | null {
  return validateMapText(source);
}

/** 一条模型配置的可读摘要（CLI/界面共用）。 */
export function describeResolved(config: ResolvedModelConfig): string {
  const capabilities: string[] = [];
  if (config.supportsJsonSchemaOutput) capabilities.push("结构化输出");
  if (config.supportsNativeWebSearch) capabilities.push("原生联网");
  if (config.supportsMidConversationSystem) capabilities.push("对话中系统消息");
  const modalities = [
    config.inputFormat.supportsImage ? "图片" : "",
    config.inputFormat.supportsVideo ? "视频" : "",
    config.inputFormat.supportsPdf ? "PDF" : "",
  ].filter(Boolean);
  return [
    config.contextWindow === undefined ? "窗口未声明" : `窗口 ${config.contextWindow}`,
    config.maxOutputTokens === undefined ? "输出未声明" : `最大输出 ${config.maxOutputTokens}`,
    `输入 ${["文本", ...modalities].join("/")}`,
    capabilities.length ? capabilities.join("、") : "无附加能力",
    config.reasoningLevels.length ? `推理档位 ${config.reasoningLevels.join("/")}` : "无推理档位",
    config.manual ? "手动" : config.matched.length ? "智能配置" : "无配置",
  ].join("；");
}
