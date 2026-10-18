import {
  readModelConfig,
  removeExactRule,
  upsertExactRule,
  writeModelConfig,
  findExactRule,
} from "../../engine/adapters/modelConfigStore";
import {
  resolveFor,
  configSourceLabel,
} from "../../engine/runtime/modelConfigResolver";
import { validateOptionMap, type ModelConfigPatch, type ModelConfigRule } from "../../engine/runtime/modelConfig";
import { validateCapabilityForProtocol } from "../../engine/runtime/modelRuntime";
import { allProviders, getProvider } from "../../engine/runtime/providers";
import { budgetBreakdown, describeBudget, parseBudgetMode } from "../../engine/runtime/budget";
import { readConfig } from "./config";
import type { Parsed } from "./args";

/**
 * `ding models` —— 模型能力表单的命令行入口（T0）。
 *
 * 三个子命令：`add`（声明/修改）、`show`（看解析结果）、`remove`（删掉声明）。
 * 不带子命令时保留原来的"列模型"行为（老用法不变）。
 *
 * ## 为什么 `--window` 是必填
 *
 * 以前没登记就走 20k 保守默认。用户来声明就是为了不走那个默认 ——
 * 所以**不给窗口就报错**，不替用户猜一个（猜 200k 对 1M 的模型是灾难，
 * 猜 1M 对小模型会直接打爆上游）。
 */

/** 把逗号分隔的列表解析成数组（去空、去重、保序）。 */
function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
}

/** 读一个正整数的旗标。 */
function positiveInt(p: Parsed, name: string): number | undefined {
  const raw = p.flags.get(name)?.[0];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

/** 子命令名（ 里已去掉命令名本身，与  同一口径）。 */
function subCommand(p: Parsed): string | undefined {
  return p.args.filter((arg) => !arg.startsWith("--"))[0];
}

/** 取第 n 个位置参数（不含旗标）。 */
function positional(p: Parsed, n: number): string | undefined {
  return p.args.filter((arg) => !arg.startsWith("--"))[n];
}

/** 命令行入口。 */
export function cmdModelsV2(p: Parsed, dataDir: string): number {
  const sub = subCommand(p);
  if (sub === "add") return addModel(p, dataDir);
  if (sub === "show") return showModel(p, dataDir);
  if (sub === "remove" || sub === "rm") return removeModel(p, dataDir);
  return -1; // 交回给原来的列表实现
}

/** `ding models add <id> --provider <p> --window <n> ...` */
function addModel(p: Parsed, dataDir: string): number {
  const modelId = positional(p, 1);
  if (!modelId) {
    process.stderr.write("要模型 id：ding models add <模型 id> --provider <provider> --window <窗口> [--max-output n]\n");
    return 2;
  }
  const { config } = readConfig(dataDir);
  const providerId = p.flags.get("provider")?.[0] ?? config.provider;
  if (!providerId) {
    process.stderr.write("要 --provider（或先在配置里设一个默认 provider）：ding models add <id> --provider <p> --window <n>\n");
    return 2;
  }
  const provider = getProvider(providerId);
  if (!provider) {
    process.stderr.write(
      `不认识的 provider：${providerId}。可选：${allProviders().map((x) => x.id).join(", ")}\n`,
    );
    return 2;
  }

  const contextWindow = positiveInt(p, "window");
  if (contextWindow === undefined) {
    /*
     * ⚠️ **不给窗口就报错**，不默认 20k / 200k。
     * 用户来声明就是为了不按保守默认跑 —— 替他猜一个数等于骗他。
     */
    process.stderr.write(
      "要 --window <正整数>（模型的上下文窗口）。" +
        "我们不知道这个模型的窗口时，不会替你猜：猜大了会打爆上游，猜小了等于没用。\n",
    );
    return 2;
  }
  const maxOutput = positiveInt(p, "max-output");
  if (maxOutput !== undefined && maxOutput >= contextWindow) {
    process.stderr.write(`--max-output ${maxOutput} 不能大于等于窗口 ${contextWindow}（那样历史就没有位置了）\n`);
    return 2;
  }

  const inputTypes = splitList(p.flags.get("input")?.[0]);
  const inputFormat = {
    supportsText: inputTypes.length === 0 || inputTypes.includes("text"),
    supportsImage: inputTypes.includes("image"),
    supportsVideo: inputTypes.includes("video"),
    supportsAudio: inputTypes.includes("audio"),
    supportsPdf: inputTypes.includes("pdf"),
  };
  if (!inputFormat.supportsText) {
    process.stderr.write("输入类型至少要有 text（纯文本是下限，不是可选项）\n");
    return 2;
  }
  const unknownTypes = inputTypes.filter((x) => !["text", "image", "video", "audio", "pdf"].includes(x));
  if (unknownTypes.length) {
    process.stderr.write(`不认识的输入类型：${unknownTypes.join("、")}（可选 text,image,video,audio,pdf）\n`);
    return 2;
  }

  const reasoningLevels = splitList(p.flags.get("reasoning-levels")?.[0]);
  if (reasoningLevels.length && new Set(reasoningLevels).size !== reasoningLevels.length) {
    process.stderr.write("推理档位不能重复\n");
    return 2;
  }
  const reasoningMap = p.flags.get("reasoning-map")?.[0];
  const maxOutputMap = p.flags.get("max-output-map")?.[0];
  for (const [name, text] of [
    ["--reasoning-map", reasoningMap],
    ["--max-output-map", maxOutputMap],
  ] as const) {
    if (text === undefined) continue;
    const error = validateOptionMap(text);
    if (error) {
      process.stderr.write(`${name} 不能用：${error}\n`);
      return 2;
    }
  }

  const properties: ModelConfigPatch["properties"] = {
    contextWindow,
    inputFormat,
    supportsToolCall: !p.flags.has("no-tools"),
    supportsJsonSchemaOutput: p.flags.has("json-output"),
    supportsNativeWebSearch: p.flags.has("native-web-search"),
    supportsMidConversationSystem: p.flags.has("mid-system"),
  };

  const optionSpecs: ModelConfigPatch["optionSpecs"] = {
    ...(reasoningLevels.length || reasoningMap
      ? {
          reasoningLevel: {
            ...(reasoningLevels.length ? { values: reasoningLevels } : {}),
            ...(reasoningMap === undefined ? {} : { map: reasoningMap }),
          },
        }
      : {}),
    ...(maxOutput !== undefined || maxOutputMap
      ? {
          maxOutputTokens: {
            ...(maxOutput === undefined ? {} : { max: maxOutput }),
            ...(maxOutputMap === undefined ? {} : { map: maxOutputMap }),
          },
        }
      : {}),
  };

  const patch: ModelConfigPatch = {
    properties,
    ...(Object.keys(optionSpecs).length ? { optionSpecs } : {}),
  };

  /* 保存前按协议校验能力（不支持的组合直接拒绝，不留到发请求时才发现） */
  const protocol = provider.protocol;
  const resolvedForCheck = resolveFor({ providerId, modelId, baseUrl: provider.baseURL }, [
    { type: "exact", providerId, modelId, config: patch, manual: true },
  ]);
  const capabilityError = validateCapabilityForProtocol(protocol, resolvedForCheck);
  if (capabilityError) {
    process.stderr.write(`${capabilityError}\n`);
    return 2;
  }

  const rule: Extract<ModelConfigRule, { type: "exact" }> = {
    type: "exact",
    providerId,
    modelId,
    config: patch,
    manual: true,
    note: `ding models add（${new Date().toISOString().slice(0, 10)}）`,
  };
  const current = readModelConfig(dataDir);
  const file = writeModelConfig(dataDir, upsertExactRule(current.file.rules, rule));

  const summary = resolveFor({ providerId, modelId, baseUrl: provider.baseURL }, [rule]);
  const breakdown = budgetBreakdown(modelId, Date.now(), parseBudgetMode(readConfig(dataDir).config.contextBudget), {
    contextWindow: summary.contextWindow,
    ...(summary.maxOutputTokens === undefined ? {} : { maxOutputTokens: summary.maxOutputTokens }),
  });
  process.stdout.write(
    [
      `✓ 已保存 ${modelId}（provider ${providerId}，${protocol}）`,
      `  ${file}`,
      `  窗口 ${summary.contextWindow} / 最大输出 ${summary.maxOutputTokens ?? "未声明"} / 历史保留 ${breakdown.keep}`,
      `  能力：${configSourceLabel(summary)}`,
      "",
    ].join("\n"),
  );
  return 0;
}

/** `ding models show <id> [--json]` */
function showModel(p: Parsed, dataDir: string): number {
  const modelId = positional(p, 1);
  if (!modelId) {
    process.stderr.write("要模型 id：ding models show <模型 id> [--json]\n");
    return 2;
  }
  const { config } = readConfig(dataDir);
  const store = readModelConfig(dataDir);
  /*
   * ⚠️ 不给 `--provider` 时**跨所有 provider 找那条声明**（2026-10-19 实测踩到）：
   *
   * 用户刚 `add` 完一个模型，紧接着 `show` 却说"未登记" —— 因为 `add` 时带了
   * `--provider tokenrhythm`，而 `show` 用了配置里的默认 provider（另一个）。
   * 用户会以为"存了没生效"。声明是**按模型 id** 记的，找的时候也该按 id 找。
   */
  const declared = store.file.rules.find(
    (rule): rule is Extract<ModelConfigRule, { type: "exact" }> =>
      rule.type === "exact" && rule.modelId === modelId,
  );
  const providerId = p.flags.get("provider")?.[0] ?? declared?.providerId ?? config.provider;
  const provider = providerId ? getProvider(providerId) : undefined;
  const resolved = resolveFor(
    {
      providerId: providerId ?? "",
      modelId,
      ...(provider ? { baseUrl: provider.baseURL } : {}),
    },
    store.file.rules,
  );
  const mode = parseBudgetMode(config.contextBudget);
  const breakdown = budgetBreakdown(modelId, Date.now(), mode, {
    ...(resolved.contextWindow === undefined ? {} : { contextWindow: resolved.contextWindow }),
    ...(resolved.maxOutputTokens === undefined ? {} : { maxOutputTokens: resolved.maxOutputTokens }),
  });

  if (p.flags.has("json")) {
    console.log(JSON.stringify({ modelId, providerId, resolved, budget: breakdown }, null, 2));
    return 0;
  }

  const manual = providerId ? findExactRule(store.file.rules, providerId, modelId) : undefined;
  process.stdout.write(
    [
      `模型 ${modelId}${providerId ? `（provider ${providerId}）` : ""}`,
      `  窗口：${resolved.contextWindow ?? "未声明"}`,
      `  最大输出：${resolved.maxOutputTokens ?? "未声明"}`,
      `  历史保留：${breakdown.keep}（档位 ${mode}）`,
      `  输入类型：${describeInput(resolved.inputFormat)}`,
      `  能力：${describeCapabilities(resolved)}`,
      `  推理档位：${resolved.reasoningLevels.length ? resolved.reasoningLevels.join(" → ") : "未声明"}`,
      `  来源：${configSourceLabel(resolved)}`,
      `  是否手动：${manual ? "是（ding models remove 可撤销）" : "否"}`,
      ...store.errors.map((error) => `  ⚠️ ${error}`),
      "",
    ].join("\n"),
  );
  return 0;
}

/** `ding models remove <id>` */
function removeModel(p: Parsed, dataDir: string): number {
  const modelId = positional(p, 1);
  if (!modelId) {
    process.stderr.write("要模型 id：ding models remove <模型 id> [--provider <p>]\n");
    return 2;
  }
  const { config } = readConfig(dataDir);
  const store = readModelConfig(dataDir);
  /* 与 `show` 同一口径：不给 --provider 时按模型 id 跨 provider 找那条声明 */
  const declared = store.file.rules.find(
    (rule): rule is Extract<ModelConfigRule, { type: "exact" }> =>
      rule.type === "exact" && rule.modelId === modelId,
  );
  const providerId = p.flags.get("provider")?.[0] ?? declared?.providerId ?? config.provider;
  if (!providerId) {
    process.stderr.write("要 --provider（或先在配置里设一个默认 provider）\n");
    return 2;
  }
  const before = store.file.rules.length;
  const next = removeExactRule(store.file.rules, providerId, modelId);
  if (next.length === before) {
    process.stdout.write(`没有找到 ${providerId}/${modelId} 的声明（无需删除）\n`);
    return 0;
  }
  const file = writeModelConfig(dataDir, next);
  process.stdout.write(`✓ 已删除 ${providerId}/${modelId} 的声明（${file}）\n`);
  return 0;
}

function describeInput(format: { [key: string]: boolean }): string {
  const names: string[] = [];
  if (format.supportsText) names.push("文本");
  if (format.supportsImage) names.push("图片");
  if (format.supportsVideo) names.push("视频");
  if (format.supportsAudio) names.push("音频");
  if (format.supportsPdf) names.push("PDF");
  return names.join("/");
}

function describeCapabilities(resolved: {
  supportsJsonSchemaOutput: boolean;
  supportsNativeWebSearch: boolean;
  supportsMidConversationSystem: boolean;
  supportsToolCall: boolean;
}): string {
  const names: string[] = [];
  if (resolved.supportsToolCall) names.push("工具调用");
  if (resolved.supportsJsonSchemaOutput) names.push("结构化输出");
  if (resolved.supportsNativeWebSearch) names.push("原生联网");
  if (resolved.supportsMidConversationSystem) names.push("对话中系统消息");
  return names.join("、") || "无";
}

/** `ding models` 里"未声明"那句人话（给列表用）。 */
export function describeDeclared(modelId: string, dataDir: string, providerId?: string): string {
  const store = readModelConfig(dataDir);
  const resolved = resolveFor({ providerId: providerId ?? "", modelId }, store.file.rules);
  return describeBudget(modelId, Date.now(), "long", {
    ...(resolved.contextWindow === undefined ? {} : { contextWindow: resolved.contextWindow }),
  });
}
