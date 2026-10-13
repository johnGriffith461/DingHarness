import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, type ToolSet } from "ai";

import { getProvider } from "./aiProviders";
import { resolveSecret } from "./credentials";
import { markProviderFailed, markProviderOk } from "./aiProbe";

/**
 * **一份主循环**（C2-3）。
 *
 * ## 它替代了什么
 *
 * 在它之前，"调一次模型、把流读出来"这件事有**两份**实现：
 * `ai.ts:164-196`（IPC 那条，`stepCountIs(4)`）与 `subagent.ts:90-101`
 * （子智能体那条，`stepCountIs(6)`）。两份各自长出了不同的毛病
 * （实测差异清单见 `docs/PLAN-C2-Agent运行时收敛.md` §1.1）：
 *
 * | 能力 | 父级 | 子级（改造前） |
 * |---|---|---|
 * | `abortSignal`（能中止） | ✅ | ❌ **子智能体点停不停** |
 * | `tool-error` 事件 | ✅ | ❌ 那一支压根没有 |
 * | provider 健康标记 | ✅ | ❌ 跑成功也不记 |
 * | 模型可用性校验 | ✅ 不在清单就退默认 | ❌ 只判真值 |
 * | `usage` | ✅ 回传渲染层 | ⚠️ 只被压成一行文案 |
 *
 * ## 两条路的差别现在只剩**参数**
 *
 * 步数上限（父 4 / 子 6）是**参数**（`maxSteps`），不是两条代码路径；
 * 事件怎么用（转给渲染层 + 落日志 / 自己收集成报告）由 `onEvent` 决定。
 *
 * ⚠️ **参数差异不许被"顺手统一"**：4 与 6 是各自的经验值，统一会改变行为与成本。
 */

/** 这一轮的用量（provider 给的；拿不到就是 undefined —— **不编**）。 */
export type TurnUsage = { inputTokens?: number; outputTokens?: number };

/**
 * 循环吐出的事件（**与 `AiStreamEvent` 分开**）。
 *
 * 为什么不让循环直接吐 `AiStreamEvent`：那个类型里有 `requestId`（IPC 归并用），
 * 而子智能体根本没有 requestId。所以这里用**同形但不含 requestId** 的事件，
 * IPC 那条在 `ai.ts` 里补上 requestId —— 那才是"传输"该干的事
 * （`shared/sessionLog.ts` 的 `ProjectableEvent` 就是这个形状，投影直接吃）。
 */
export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output?: unknown; error?: string }
  /** 一步结束（AI SDK 的 `finish`）—— 数步数用。**投影会忽略它**（它不改变内容）。 */
  | { type: "step-finish" }
  | { type: "done"; usage?: TurnUsage }
  | { type: "error"; message: string };

/** 一次调用的输入。 */
export type TurnRequestInput = {
  provider: string;
  model?: string;
  system?: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  maxOutputTokens?: number;
  /** 工具集；不给就是"不带工具"的一轮（起标题、翻译这类）。 */
  tools?: ToolSet;
  /** 步数上限（父 4 / 子 6 都是这个参数）。 */
  maxSteps?: number;
  /**
   * 中止信号。
   *
   * ⚠️ 子智能体**必须**拿到父级的那个：用户点停时，子智能体还在跑就是"停不下来"。
   */
  abortSignal?: AbortSignal;
};

/** 一次调用的结果（两条路都能用：IPC 那条主要靠 `onEvent`，子智能体主要靠它）。 */
export type TurnOutcome = {
  ok: boolean;
  /** 失败原因（给人看的一句话）。 */
  error?: string;
  /** 是否被中止（**中止不算失败**：那是用户意图，不该把 provider 判死）。 */
  aborted: boolean;
  /** 真正用的 provider / model（解析后的）。 */
  provider: string;
  model: string;
};

/**
 * 把 provider 的错误翻成给人看的一句话。
 *
 * ⚠️ 这是原来 `ai.ts` 里的 `humanError`：**两条路共用**（子智能体的失败也要说人话，
 * 而不是把 SDK 的原始报错丢给用户）。
 *
 * @param error 抛出来的东西
 * @returns 一句话
 */
export function humanError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "已中止";
  const raw = error instanceof Error ? error.message : String(error);
  if (/401|unauthorized|invalid api key/i.test(raw)) return "密钥无效或已过期";
  if (/404|model.*not.*found/i.test(raw)) return "模型不存在（检查模型名与 provider）";
  if (/429|rate limit/i.test(raw)) return "触发限流，稍后重试";
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(raw)) {
    return "连不上 provider（网络问题，或本地服务未启动）";
  }
  if (/insufficient|balance|quota/i.test(raw)) return "余额不足";
  return raw.slice(0, 200);
}

/**
 * 解析"这一轮到底发给谁"：provider 存不存在、有没有密钥、模型名认不认。
 *
 * ⚠️ 单独抽出来是因为两条路都需要它、但**时机不同**：
 * `ai:chat` 必须在**同步返回**里给出 `{provider, model}`（渲染层拿它显示），
 * 而 `runTurn` 是在异步体里才知道。一份实现、两处调用，避免"两处各写一遍模型回落规则"。
 *
 * @param providerId provider id
 * @param model 请求里带的模型名（可选）
 * @returns 解析结果（失败时给一句给人看的话）
 */
export function resolveTurnTarget(
  providerId: string,
  model?: string,
): { ok: true; provider: NonNullable<ReturnType<typeof getProvider>>; model: string } | { ok: false; error: string } {
  const provider = getProvider(providerId);
  if (!provider) return { ok: false, error: `未知 provider：${providerId}` };
  if (!resolveSecret(provider.keyRef)) {
    return { ok: false, error: `${provider.label} 没有可用密钥（需要 ${provider.keyRef}）` };
  }
  const picked = model && provider.models.includes(model) ? model : (provider.models[0] ?? "");
  return { ok: true, provider, model: picked };
}

/**
 * 跑一轮（**主进程里唯一的主循环**）。
 *
 * 它负责：解析 provider/密钥/模型 → 建客户端 → 跑 `streamText` → 把 `fullStream`
 * 翻成 `TurnEvent` → 记 provider 健康 → 收尾时把 `usage` 交给调用方。
 *
 * 调用方负责：事件怎么用（`onEvent`）、以及**给不给工具**（`tools`）。
 *
 * @param input 见 `TurnRequestInput`
 * @param onEvent 每个事件的出口（同步调用；抛异常会中断这一轮）
 * @returns 结局（成败 / 中止 / 真正用的模型）
 */
export async function runTurn(
  input: TurnRequestInput,
  onEvent: (event: TurnEvent) => void,
): Promise<TurnOutcome> {
  const provider = getProvider(input.provider);
  if (!provider) {
    const message = `未知 provider：${input.provider}`;
    onEvent({ type: "error", message });
    return { ok: false, error: message, aborted: false, provider: input.provider, model: "" };
  }

  const apiKey = resolveSecret(provider.keyRef);
  if (!apiKey) {
    const message = `${provider.label} 没有可用密钥（需要 ${provider.keyRef}）`;
    onEvent({ type: "error", message });
    return { ok: false, error: message, aborted: false, provider: provider.id, model: "" };
  }

  /*
   * 模型校验：**不在清单里就退回默认**（原来只有父级这么做，子级只判真值 ——
   * 于是子智能体可以拿一个不存在的模型名去请求，然后以"连不上"的形式失败）。
   */
  const model = input.model && provider.models.includes(input.model) ? input.model : (provider.models[0] ?? "");

  try {
    const client = createOpenAICompatible({ name: provider.id, baseURL: provider.baseURL, apiKey });
    const result = streamText({
      model: client(model),
      messages: input.messages,
      ...(input.system ? { system: input.system } : {}),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.tools
        ? { tools: input.tools, stopWhen: stepCountIs(input.maxSteps ?? 6) }
        : {}),
    });

    for await (const part of result.fullStream) {
      if (input.abortSignal?.aborted) break;
      if (part.type === "text-delta") {
        onEvent({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "tool-call") {
        onEvent({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
        continue;
      }
      if (part.type === "tool-result" || part.type === "tool-error") {
        /*
         * 工具抛错**不中断这一轮**：AI SDK 把它变成 `tool-error`，
         * 我们照样当一次工具结果回注（goose / 12-factor 的口径：错误也是结果）。
         * ⚠️ 子智能体那条原来**没有这一支** —— 于是它的工具报错会被整轮吞掉。
         */
        const failed = part.type === "tool-error";
        onEvent({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          ...(failed
            ? { error: part.error instanceof Error ? part.error.message : String(part.error) }
            : { output: part.output }),
        });
        continue;
      }
      if (part.type === "finish") {
        onEvent({ type: "step-finish" });
        continue;
      }
      if (part.type === "error") throw part.error;
    }

    if (input.abortSignal?.aborted) {
      // 中止是用户意图：**不判 provider 失败**，也不当作错误结局
      return { ok: true, aborted: true, provider: provider.id, model };
    }

    let usage: TurnUsage | undefined;
    try {
      const final = await result.usage;
      usage = { inputTokens: final.inputTokens, outputTokens: final.outputTokens };
    } catch {
      usage = undefined; // 拿不到就不给（**不编**）
    }
    onEvent({ type: "done", ...(usage ? { usage } : {}) });
    // 真的跑通了 —— 把这家 provider 标成"已验证"（界面上才敢说可用）
    markProviderOk(provider.id);
    return { ok: true, aborted: false, provider: provider.id, model };
  } catch (error) {
    const message = humanError(error);
    const aborted = Boolean(input.abortSignal?.aborted);
    if (!aborted) markProviderFailed(provider.id, message);
    onEvent({ type: "error", message });
    return { ok: false, error: message, aborted, provider: provider.id, model };
  }
}
