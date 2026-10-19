import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ipcMain } from "electron";

import { readModelConfig, removeExactRule, upsertExactRule, writeModelConfig } from "../../engine/adapters/modelConfigStore";
import {
  resolveFor,
  configSourceLabel,
  resolveUserOnly,
} from "../../engine/runtime/modelConfigResolver";
import { validateOptionMap, type ModelConfigPatch } from "../../engine/runtime/modelConfig";
import { keepTokensFor, parseBudgetMode } from "../../engine/runtime/budget";
import { blockedReason, realModelBlocked } from "../../engine/runtime/modelGate";
import { getProvider } from "../../engine/runtime/providers";
import { buildEngine } from "../../hosts/cli/assembly";
import type {
  DeclaredModelWire,
  ModelConfigListResult,
  ModelConfigSaveInput,
  ModelConfigSaveResult,
  ModelConfigProbeResult,
  ModelConfigWire,
} from "../../shared/modelConfigWire";

/**
 * **模型能力表单的桌面 IPC**（T0）。
 *
 * 与 CLI 用同一份 `models.json`、同一套解析与校验 —— 两条路各写一份判定是
 * 这类功能最常见的分叉来源（界面上能存、CLI 读不到；或者反过来）。
 */

export const MODEL_CONFIG_CHANNEL = {
  list: "modelConfig:list",
  save: "modelConfig:save",
  remove: "modelConfig:remove",
  validateMap: "modelConfig:validateMap",
  probe: "modelConfig:probe",
} as const;

/** 把解析结果摊成界面要的完整形状（`reasoningLevels` 空时给空数组，不给 undefined）。 */
function toWireConfig(resolved: ReturnType<typeof resolveFor>): ModelConfigWire {
  return {
    enabled: resolved.enabled,
    properties: {
      requiresMfjsToolSchema: resolved.requiresMfjsToolSchema,
      contextWindow: resolved.contextWindow ?? 0,
      inputFormat: resolved.inputFormat,
      outputFormat: resolved.outputFormat,
      supportsToolCall: resolved.supportsToolCall,
      supportsJsonSchemaOutput: resolved.supportsJsonSchemaOutput,
      supportsNativeWebSearch: resolved.supportsNativeWebSearch,
      supportsMidConversationSystem: resolved.supportsMidConversationSystem,
    },
    optionSpecs: {
      reasoningLevel: { values: resolved.reasoningLevels, map: resolved.reasoningMap ?? "" },
      maxOutputTokens: { max: resolved.maxOutputTokens ?? 0, map: resolved.maxOutputMap ?? "" },
    },
  };
}

/** 列出用户声明过的模型（每个 provider/model 一条）。 */
export function listDeclaredModels(dataDir: string, contextBudget?: string): ModelConfigListResult {
  const store = readModelConfig(dataDir);
  const exacts = store.file.rules.filter(
    (rule): rule is Extract<typeof rule, { type: "exact" }> => rule.type === "exact",
  );
  const mode = parseBudgetMode(contextBudget);

  const models: DeclaredModelWire[] = exacts.map((rule) => {
    const resolved = resolveFor(
      { providerId: rule.providerId, modelId: rule.modelId },
      store.file.rules,
    );
    /* 哪些字段是用户手动改的：拿"只看用户规则"的解析结果跟全量解析比 */
    const userOnly = resolveUserOnly(
      { providerId: rule.providerId, modelId: rule.modelId },
      store.file.rules,
    );
    const overrides: string[] = [];
    if (userOnly.contextWindow !== undefined) overrides.push("contextWindow");
    if (userOnly.maxOutputTokens !== undefined) overrides.push("maxOutputTokens");
    if (userOnly.reasoningLevels.length) overrides.push("reasoningLevel");
    if (userOnly.supportsJsonSchemaOutput) overrides.push("supportsJsonSchemaOutput");
    if (userOnly.supportsNativeWebSearch) overrides.push("supportsNativeWebSearch");
    if (userOnly.supportsMidConversationSystem) overrides.push("supportsMidConversationSystem");
    if (userOnly.inputFormat.supportsImage || userOnly.inputFormat.supportsPdf || userOnly.inputFormat.supportsVideo) {
      overrides.push("inputFormat");
    }

    return {
      providerId: rule.providerId,
      modelId: rule.modelId,
      config: toWireConfig(resolved),
      overrides,
      source: configSourceLabel(resolved),
      keepTokens: keepTokensFor(rule.modelId, Date.now(), mode, {
        ...(resolved.contextWindow === undefined ? {} : { contextWindow: resolved.contextWindow }),
        ...(resolved.maxOutputTokens === undefined ? {} : { maxOutputTokens: resolved.maxOutputTokens }),
      }),
    };
  });

  return { models, errors: store.errors };
}

/** 保存一条声明。校验顺序与 CLI 一致：先映射，再能力（能力那步在 CLI 里还要按协议判）。 */
export function saveDeclaredModel(dataDir: string, input: ModelConfigSaveInput): ModelConfigSaveResult {
  try {
    if (!input.modelId.trim()) return { ok: false, error: "模型 ID 不能为空" };
    if (!input.providerId.trim()) return { ok: false, error: "provider 不能为空" };

    const patch = input.patch;
    const window = patch.contextWindow;
    if (typeof window === "number" && (!Number.isInteger(window) || window <= 0)) {
      return { ok: false, error: "上下文窗口必须是正整数" };
    }
    const maxOutput = patch.maxOutputTokens;
    if (typeof maxOutput === "number") {
      if (!Number.isInteger(maxOutput) || maxOutput <= 0) {
        return { ok: false, error: "最大输出 Token 必须是正整数" };
      }
      if (typeof window === "number" && maxOutput >= window) {
        return { ok: false, error: "最大输出不能大于等于上下文窗口（那样历史就没有位置了）" };
      }
    }
    const levels = patch.reasoningLevels;
    if (Array.isArray(levels)) {
      if (levels.length === 0) return { ok: false, error: "推理档位至少要留一个（不要就整项不填）" };
      if (new Set(levels).size !== levels.length) return { ok: false, error: "推理档位不能重复" };
      if (levels.some((level) => !level.trim())) return { ok: false, error: "推理档位不能有空字符串" };
    }
    for (const [name, text] of [
      ["推理参数映射", patch.reasoningMap],
      ["输出参数映射", patch.maxOutputMap],
    ] as const) {
      if (typeof text === "string" && text.trim()) {
        const error = validateOptionMap(text);
        if (error) return { ok: false, error: `${name}：${error}` };
      }
    }

    /* 补丁 → 规则配置（只放用户真的给了的字段） */
    const config: ModelConfigPatch = {
      properties: {
        ...(window === undefined ? {} : { contextWindow: window }),
        ...(patch.inputFormat === undefined ? {} : { inputFormat: patch.inputFormat }),
        ...(patch.supportsToolCall === undefined ? {} : { supportsToolCall: patch.supportsToolCall }),
        ...(patch.supportsJsonSchemaOutput === undefined
          ? {}
          : { supportsJsonSchemaOutput: patch.supportsJsonSchemaOutput }),
        ...(patch.supportsNativeWebSearch === undefined
          ? {}
          : { supportsNativeWebSearch: patch.supportsNativeWebSearch }),
        ...(patch.supportsMidConversationSystem === undefined
          ? {}
          : { supportsMidConversationSystem: patch.supportsMidConversationSystem }),
      },
      optionSpecs: {
        ...(Array.isArray(levels) || typeof patch.reasoningMap === "string"
          ? {
              reasoningLevel: {
                ...(Array.isArray(levels) ? { values: levels } : {}),
                ...(typeof patch.reasoningMap === "string" ? { map: patch.reasoningMap } : {}),
              },
            }
          : {}),
        ...(typeof maxOutput === "number" || typeof patch.maxOutputMap === "string"
          ? {
              maxOutputTokens: {
                ...(typeof maxOutput === "number" ? { max: maxOutput } : {}),
                ...(typeof patch.maxOutputMap === "string" ? { map: patch.maxOutputMap } : {}),
              },
            }
          : {}),
      },
    };

    const store = readModelConfig(dataDir);
    const file = writeModelConfig(
      dataDir,
      upsertExactRule(store.file.rules, {
        type: "exact",
        providerId: input.providerId,
        modelId: input.modelId,
        config,
        manual: input.manual !== false,
      }),
    );

    const resolved = resolveFor(
      { providerId: input.providerId, modelId: input.modelId },
      readModelConfig(dataDir).file.rules,
    );
    return {
      ok: true,
      path: file,
      keepTokens: keepTokensFor(input.modelId, Date.now(), "long", {
        ...(resolved.contextWindow === undefined ? {} : { contextWindow: resolved.contextWindow }),
        ...(resolved.maxOutputTokens === undefined ? {} : { maxOutputTokens: resolved.maxOutputTokens }),
      }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 注册通道。 */
export function registerModelConfigIpc(getDataDir: () => string): void {
  /* 档位由渲染侧传进来：桌面把它存在 localStorage（与 taskRuntime 同一口径） */
  ipcMain.handle(MODEL_CONFIG_CHANNEL.list, (_event, contextBudget?: string) =>
    listDeclaredModels(getDataDir(), contextBudget),
  );
  ipcMain.handle(MODEL_CONFIG_CHANNEL.save, (_event, input: ModelConfigSaveInput) =>
    saveDeclaredModel(getDataDir(), input),
  );
  ipcMain.handle(MODEL_CONFIG_CHANNEL.remove, (_event, providerId: string, modelId: string) => {
    const store = readModelConfig(getDataDir());
    writeModelConfig(getDataDir(), removeExactRule(store.file.rules, providerId, modelId));
    return { ok: true };
  });
  ipcMain.handle(MODEL_CONFIG_CHANNEL.validateMap, (_event, text: string) => {
    const error = validateOptionMap(text);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle(MODEL_CONFIG_CHANNEL.probe, (_event, providerId: string, modelId: string) =>
    probeDeclaredModel({ dataDir: getDataDir(), providerId, modelId }),
  );
}

/**
 * **单个模型的连通性测试**（T0）。
 *
 * ## 为什么不能复用 `probeProviders`
 *
 * 那个是"这家通道活没活"（用 provider 的第一个模型、不带任何能力配置）。
 * 这里要回答的是"**我刚声明的这个模型**能不能用"，所以必须：
 * - 用它声明的模型名（拼错要当场发现）；
 * - 带上它的参数映射与输出上限（上游嫌 `max_tokens` 太大就会 400）；
 * - 走与真实回合同一条装配路径（`buildEngine`），不是另写一份请求。
 *
 * ## 它花钱
 *
 * 一轮最小请求（提示词 "1"，输出 1 个 token 量级）。所以：
 * - 零出网闸开着就**直接拒绝**并说明原因（不记成"模型坏了"）；
 * - 结果里如实给墙钟与实际用量。
 */
export async function probeDeclaredModel(input: {
  dataDir: string;
  providerId: string;
  modelId: string;
}): Promise<ModelConfigProbeResult> {
  const started = Date.now();
  const provider = getProvider(input.providerId);
  if (!provider) {
    return { ok: false, error: `不认识的 provider：${input.providerId}`, elapsedMs: 0 };
  }
  if (realModelBlocked(provider.baseURL)) {
    return {
      ok: false,
      error: blockedReason(`测试模型 ${input.modelId}`, provider.baseURL),
      elapsedMs: 0,
    };
  }

  const store = readModelConfig(input.dataDir);
  const resolved = resolveFor(
    { providerId: input.providerId, modelId: input.modelId, baseUrl: provider.baseURL },
    store.file.rules,
  );

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-probe-"));
  let built: Awaited<ReturnType<typeof buildEngine>> | undefined;
  try {
    built = await buildEngine([workDir], input.dataDir);
    const outcome = await built.engine.run({
      sessionId: `probe-${Date.now()}`,
      provider: input.providerId,
      model: input.modelId,
      system: "只回一个字符。",
      messages: [{ role: "user", content: "1" }],
      mode: "全部允许",
      maxSteps: 1,
      modelConfig: resolved,
      /* 用户声明的模型可能不在 provider 清单里 —— 这正是要测它的原因 */
      allowUndeclaredModel: true,
      stallTimeoutMs: 60_000,
    });
    const elapsedMs = Date.now() - started;
    if (!outcome.ok) return { ok: false, error: outcome.error ?? "没有给出原因", elapsedMs };
    /* 收集模型真的说了什么（`done` 事件里带 usage；正文在 text 事件里） */
    const texts = outcome.events
      .filter((event: { type: string }) => event.type === "text")
      .map((event) => (event as { text?: string }).text ?? "")
      .join("");
    const usage = (outcome.events.findLast?.((event: { type: string }) => event.type === "done") as
      | { usage?: { inputTokens?: number; outputTokens?: number } }
      | undefined)?.usage;
    return {
      ok: true,
      reply: texts.slice(0, 120) || "（模型没有返回文本，但请求成功）",
      elapsedMs,
      ...(usage
        ? {
            usage: {
              ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
              ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
            },
          }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    };
  } finally {
    built?.close();
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}
