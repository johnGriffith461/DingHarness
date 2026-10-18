import fs from "node:fs";
import path from "node:path";

import type { ModelConfigPatch, ModelConfigRule } from "../runtime/modelConfig";

/**
 * 模型配置的持久化（T0）：`<数据目录>/models.json`。
 *
 * ## 为什么单独一个文件，不塞进 `config.json`
 *
 * 两件事不应该长在一起：
 * - `config.json` 是**这台机器怎么连 provider**（provider / model / 档位 / 目录）；
 * - `models.json` 是**这些模型有什么能力**（窗口 / 输出 / 模态 / 映射）。
 *
 * 前者换机器要重填，后者是可以分享的"知识"（甚至可以直接照抄官方文档填）。
 * 合成一个文件之后，备份/导入会把两者绑在一起，用户想只带走模型声明也做不到。
 *
 * ## 兼容
 *
 * 文件不存在 = 没有任何用户规则 = 行为与以前**完全一致**（走内置推荐）。
 * 所以老用户升级不需要迁移，也不会因为少一个文件而崩。
 */

export const MODEL_CONFIG_FILENAME = "models.json";
export const MODEL_CONFIG_VERSION = 1;

export type ModelConfigFile = {
  version: number;
  rules: ModelConfigRule[];
};

/** 文件位置。 */
export function modelConfigPath(dataDir: string): string {
  return path.join(dataDir, MODEL_CONFIG_FILENAME);
}

/** 空文件内容。 */
export function emptyModelConfigFile(): ModelConfigFile {
  return { version: MODEL_CONFIG_VERSION, rules: [] };
}

/**
 * 读用户规则。
 *
 * ⚠️ **坏文件不抛**：一个坏掉的 `models.json` 不该让整个应用起不来。
 * 但也不能静默吞掉 —— 返回 `errors` 让调用方（doctor / `ding models list`）说出来。
 */
export function readModelConfig(dataDir: string): { file: ModelConfigFile; errors: string[] } {
  const file = modelConfigPath(dataDir);
  const errors: string[] = [];
  if (!fs.existsSync(file)) return { file: emptyModelConfigFile(), errors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    return { file: emptyModelConfigFile(), errors };
  }

  const record = parsed as Partial<ModelConfigFile> | null;
  if (!record || typeof record !== "object" || !Array.isArray(record.rules)) {
    errors.push(`${file} 形状不对：期望 { version, rules: [...] }`);
    return { file: emptyModelConfigFile(), errors };
  }

  const rules: ModelConfigRule[] = [];
  record.rules.forEach((rule, index) => {
    const checked = validateRule(rule);
    if (typeof checked === "string") {
      errors.push(`第 ${index + 1} 条规则被跳过：${checked}`);
      return;
    }
    rules.push(checked);
  });

  return {
    file: { version: typeof record.version === "number" ? record.version : MODEL_CONFIG_VERSION, rules },
    errors,
  };
}

/** 写用户规则。原子写（先写临时文件再 rename），避免写一半断电留下坏 JSON。 */
export function writeModelConfig(dataDir: string, rules: readonly ModelConfigRule[]): string {
  const file = modelConfigPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ version: MODEL_CONFIG_VERSION, rules }, null, 2) + "\n";
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

/** 校验一条规则；返回错误消息（字符串）或收窄后的规则。 */
export function validateRule(value: unknown): ModelConfigRule | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "不是对象";
  const rule = value as Record<string, unknown>;
  const config = rule.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return "缺 config 对象";

  switch (rule.type) {
    case "model":
      if (typeof rule.modelMatch !== "string" || !rule.modelMatch) return "model 规则缺 modelMatch";
      return {
        type: "model",
        modelMatch: rule.modelMatch,
        config: config as ModelConfigPatch,
        ...(typeof rule.note === "string" ? { note: rule.note } : {}),
      };
    case "model-api":
      if (typeof rule.modelMatch !== "string" || !rule.modelMatch) return "model-api 规则缺 modelMatch";
      if (typeof rule.apiTypeMatch !== "string" || !rule.apiTypeMatch) return "model-api 规则缺 apiTypeMatch";
      return {
        type: "model-api",
        modelMatch: rule.modelMatch,
        apiTypeMatch: rule.apiTypeMatch,
        config: config as ModelConfigPatch,
        ...(typeof rule.note === "string" ? { note: rule.note } : {}),
      };
    case "provider-site":
      if (typeof rule.modelMatch !== "string" || !rule.modelMatch) return "provider-site 规则缺 modelMatch";
      if (typeof rule.baseUrlMatch !== "string" || !rule.baseUrlMatch) return "provider-site 规则缺 baseUrlMatch";
      return {
        type: "provider-site",
        modelMatch: rule.modelMatch,
        baseUrlMatch: rule.baseUrlMatch,
        ...(typeof rule.apiTypeMatch === "string" ? { apiTypeMatch: rule.apiTypeMatch } : {}),
        config: config as ModelConfigPatch,
        ...(typeof rule.note === "string" ? { note: rule.note } : {}),
      };
    case "exact":
      if (typeof rule.providerId !== "string" || !rule.providerId) return "exact 规则缺 providerId";
      if (typeof rule.modelId !== "string" || !rule.modelId) return "exact 规则缺 modelId";
      return {
        type: "exact",
        providerId: rule.providerId,
        modelId: rule.modelId,
        config: config as ModelConfigPatch,
        manual: rule.manual === true,
        ...(typeof rule.note === "string" ? { note: rule.note } : {}),
      };
    default:
      return `未知的规则类型 ${JSON.stringify(rule.type)}`;
  }
}

/**
 * 加/换一条 `exact` 规则（同一个 provider+model 只保留一条）。
 *
 * 用户改了两次同一模型的窗口，不该留下两条互相叠加的规则 ——
 * 那会让"我明明改成 200k 了"变成"为什么还是 966k"。
 */
export function upsertExactRule(
  rules: readonly ModelConfigRule[],
  next: Extract<ModelConfigRule, { type: "exact" }>,
): ModelConfigRule[] {
  const kept = rules.filter(
    (rule) => !(rule.type === "exact" && rule.providerId === next.providerId && rule.modelId === next.modelId),
  );
  return [...kept, next];
}

/** 删一条 `exact` 规则。 */
export function removeExactRule(
  rules: readonly ModelConfigRule[],
  providerId: string,
  modelId: string,
): ModelConfigRule[] {
  return rules.filter(
    (rule) => !(rule.type === "exact" && rule.providerId === providerId && rule.modelId === modelId),
  );
}

/** 找一条 `exact` 规则。 */
export function findExactRule(
  rules: readonly ModelConfigRule[],
  providerId: string,
  modelId: string,
): Extract<ModelConfigRule, { type: "exact" }> | undefined {
  return rules.find(
    (rule): rule is Extract<ModelConfigRule, { type: "exact" }> =>
      rule.type === "exact" && rule.providerId === providerId && rule.modelId === modelId,
  );
}
