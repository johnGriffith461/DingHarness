import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, type ToolSet } from "ai";

import type { StepUsage } from "../../shared/cost";
import type { HealthStore } from "../ports/health";
import { noopHealth } from "../ports/health";
import { getProvider } from "./providers";
import { resolveSecret } from "./credentials";

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
export type TurnUsage = StepUsage;

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
/*
 * ⚠️ 这里**没有** `maxOutputTokens`（C5 裁定）：它原来是"有管道没水源"的 ——
 * 契约里有 `maxTokens`、主进程也接了，但**渲染层从没传过**（`src/` 全仓零命中），
 * 端到端一次都没生效。按手册"要么被用要么被删"，删掉这条管道。
 * **要用的时候再加回来**，并且那时**同时**要有界面上的水源（否则又是一条空管道）。
 * （provider 自己的默认输出上限一直生效，不受这里影响。）
 */
export type TurnRequestInput = {
  provider: string;
  model?: string;
  system?: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
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
/**
 * 「禁止真实模型」这道闸（`DSH_NO_REAL_MODEL`）。
 *
 * ## 为什么它必须真的存在
 *
 * CI 的 workflow 里一直写着这个变量，注释还承诺"万一有人把真调模型的验收加进来，
 * 这个变量会让它们立刻失败而不是悄悄烧钱"—— 而**仓库里没有任何代码读它**。
 * 也就是说那句承诺是空的：闸门画在墙上，门是开的。
 *
 * （实测过代价：跑一条验收脚本 `accept-tools.mjs` 会真的打 provider，
 * 它往输入框里填提示词然后点发送。整批 99 条跑一遍就是 99 次真调用。）
 *
 * 判据是**地址**而不是"哪个 provider"：指向 `127.0.0.1`/`localhost` 的（本地假服务、
 * 本地推理）照常放行 —— 那正是"不烧钱地测主循环"该走的路。
 *
 * ⚠️ 解析不出主机名时**当远程拦掉**：宁可拦错一次，不要放过一次真花钱的调用。
 *
 * @param baseURL provider 的地址
 * @returns 是否该拒
 */
function realModelBlocked(baseURL: string): boolean {
  if (!process.env.DSH_NO_REAL_MODEL?.trim()) return false;
  try {
    const host = new URL(baseURL).hostname;
    return !(host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]");
  } catch {
    return true;
  }
}

export function resolveTurnTarget(
  providerId: string,
  model?: string,
): { ok: true; provider: NonNullable<ReturnType<typeof getProvider>>; model: string } | { ok: false; error: string } {
  const provider = getProvider(providerId);
  if (!provider) return { ok: false, error: `未知 provider：${providerId}` };
  if (realModelBlocked(provider.baseURL)) {
    return {
      ok: false,
      error: `DSH_NO_REAL_MODEL 已设置：拒绝调用远程 provider（${provider.label} → ${provider.baseURL}）。只有指向本机的任务才允许跑。`,
    };
  }
  if (!resolveSecret(provider.keyRef)) {
    return { ok: false, error: `${provider.label} 没有可用密钥（需要 ${provider.keyRef}）` };
  }
  const picked = model && provider.models.includes(model) ? model : (provider.models[0] ?? "");
  return { ok: true, provider, model: picked };
}

/**
 * 主循环要用到的**外部能力**（Phase 1 D1：内核不再直接 import 宿主的东西）。
 *
 * ⚠️ 只放"内核不能自己造"的东西：现在只有 provider 健康账本 ——
 * 记到哪儿是宿主的事（桌面写 userData、CLI 单跑不必记、测试给假的）。
 * **可选**是因为它纯属记账，缺了不影响跑一轮；默认 `noopHealth` 而不是 `undefined`，
 * 免得循环里到处 `?.`（那会让"没给"与"不用记"两种意思混在一起）。
 */
export type TurnDeps = {
  health?: HealthStore;
};

/**
 * 跑一轮（**内核里唯一的主循环**）。
 *
 * 它负责：解析 provider/密钥/模型 → 建客户端 → 跑 `streamText` → 把 `fullStream`
 * 翻成 `TurnEvent` → 记 provider 健康 → 收尾时把 `usage` 交给调用方。
 *
 * 调用方负责：事件怎么用（`onEvent`）、以及**给不给工具**（`tools`）。
 *
 * @param input 见 `TurnRequestInput`
 * @param onEvent 每个事件的出口（同步调用；抛异常会中断这一轮）
 * @param deps 见 `TurnDeps`（宿主注入的外部能力）
 * @returns 结局（成败 / 中止 / 真正用的模型）
 */
export async function runTurn(
  input: TurnRequestInput,
  onEvent: (event: TurnEvent) => void,
  deps: TurnDeps = {},
): Promise<TurnOutcome> {
  const health = deps.health ?? noopHealth;

  /*
   * ⭐ provider / 模型 / 「禁真模型」闸**只有一份判定**：`resolveTurnTarget`。
   *
   * ⚠️ 这里原来自己又写了一遍（getProvider + 查密钥 + 模型回落）。于是上面那句
   * 注释"规则只有一份（resolveTurnTarget），这里用的也是它"**是假的** ——
   * 而代价实测到了：给 `resolveTurnTarget` 加上的防烧钱闸，
   * 通过 `ding run` 走这条路时**完全没生效**，一次真调用照打出去。
   *
   * 被复制一份的判定，就是会被绕过的那一份。
   */
  const target = resolveTurnTarget(input.provider, input.model);
  if (!target.ok) {
    onEvent({ type: "error", message: target.error });
    return { ok: false, error: target.error, aborted: false, provider: input.provider, model: "" };
  }
  const provider = target.provider;
  const model = target.model;

  const apiKey = resolveSecret(provider.keyRef);
  if (!apiKey) {
    const message = `${provider.label} 没有可用密钥（需要 ${provider.keyRef}）`;
    onEvent({ type: "error", message });
    return { ok: false, error: message, aborted: false, provider: provider.id, model: "" };
  }

  try {
    const client = createOpenAICompatible({ name: provider.id, baseURL: provider.baseURL, apiKey });
    /*
     * 这一轮**真的**花了多久 —— 吞吐量（tok/s）的分母。
     * 量的是"从发请求到 provider 把用量交回来"这一段；界面上那个数因此是实测，不是估的。
     */
    const startedAt = Date.now();
    const result = streamText({
      model: client(model),
      messages: input.messages,
      ...(input.system ? { system: input.system } : {}),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
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
      /*
       * ⚠️ 除了输入/输出，还要把 provider 的**缓存明细**带回去（2026-10-14）：
       * AI SDK 给了 `inputTokenDetails.noCacheTokens / cacheReadTokens / cacheWriteTokens`，
       * 而这里**原来只取了两个字段就把对象丢了** —— 于是界面上"缓存命中/缓存读取"永远没有数据，
       * 不是"provider 没给"，是我们没接。缺字段照旧**不编**（有就带上，没有就不带）。
       */
      const d = final.inputTokenDetails;
      usage = {
        inputTokens: final.inputTokens,
        outputTokens: final.outputTokens,
        ...(typeof d?.noCacheTokens === "number" ? { noCacheTokens: d.noCacheTokens } : {}),
        ...(typeof d?.cacheReadTokens === "number" ? { cacheReadTokens: d.cacheReadTokens } : {}),
        ...(typeof d?.cacheWriteTokens === "number" ? { cacheWriteTokens: d.cacheWriteTokens } : {}),
        elapsedMs: Date.now() - startedAt,
      };
    } catch {
      usage = undefined; // 拿不到就不给（**不编**）
    }
    onEvent({ type: "done", ...(usage ? { usage } : {}) });
    // 真的跑通了 —— 把这家 provider 标成"已验证"（界面上才敢说可用）
    health.markOk(provider.id);
    return { ok: true, aborted: false, provider: provider.id, model };
  } catch (error) {
    const message = humanError(error);
    const aborted = Boolean(input.abortSignal?.aborted);
    if (!aborted) health.markFailed(provider.id, message);
    onEvent({ type: "error", message });
    return { ok: false, error: message, aborted, provider: provider.id, model };
  }
}
