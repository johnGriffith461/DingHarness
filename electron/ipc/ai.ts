import { ipcMain, type WebContents } from "electron";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText } from "ai";
import { resolveSecret } from "./credentials";
import { getProvider } from "./aiProviders";
import { listProvidersWithProbe, markProviderFailed, markProviderOk, probeProviders } from "./aiProbe";
import { agentTools, runToolOnce, type ToolEnv } from "./tools";
import { describeToolResult } from "../../shared/agentTools";
import type { AiStreamEvent, ChatRequest, ToolRunRequest, ToolRunResult } from "../../shared/ipc";

/**
 * AI IPC（PLAN 3.1 / 3.2）。
 *
 * 分工：渲染进程只发「用哪个 provider / 哪个模型 / 什么消息」，主进程负责拿 key、
 * 建模型、转发流式片段。**key 与 baseURL 都不离开主进程**。
 *
 * 流式片段按 ~40ms 合批再发（一个字一次 IPC 会把渲染进程淹掉）；
 * 每个请求配一个 AbortController，中止时连 provider 侧的连接一起断开。
 */

export const AI_CHANNEL = {
  listProviders: "ai:listProviders",
  probe: "ai:probe",
  chat: "ai:chat",
  abort: "ai:abort",
  /** 用户放行后执行一次被拦下的工具调用（§144）。 */
  runTool: "ai:runTool",
  /** 主进程 → 渲染进程：流片段。 */
  stream: "ai:stream",
} as const;

/*
 * ⚠️ 这三个类型也**搬去 `shared/ipc.ts` 了**（§143）。
 *
 * 与 §141 的 `AiStreamEvent` 是同一类问题：`ChatRequest` 在两处各写了一份，
 * 于是"加一个字段"（比如这次要加的 `toolPolicy`）只改一边也**不报错**，
 * 只会表现为"传过去的值莫名不见了"。现在只有一份。
 */
export type { ChatMessage, ChatRequest, ChatRole } from "../../shared/ipc";

/** 流事件：渲染进程按 requestId 归并。 */
/*
 * ⚠️ 定义**搬去 `shared/ipc.ts` 了**（§141）。
 *
 * 这里原来自己又写了一份，与共享那份**逐字重复** —— 就是本项目反复清的那类
 * "同一状态两处定义"：加一种事件类型时只改一处，另一处不会报错、只会**静默不认**。
 * 现在只有一份，这里只做转发（保留导出，免得别处 import 路径变动）。
 */
export type { AiStreamEvent } from "../../shared/ipc";

type LiveStream = { controller: AbortController };

const liveStreams = new Map<string, LiveStream>();

/** 渲染进程可能已经刷新/关闭，发送前确认目标还在。 */
function safeSend(sender: WebContents, event: AiStreamEvent): void {
  if (sender.isDestroyed()) return;
  try {
    sender.send(AI_CHANNEL.stream, event);
  } catch {
    /* 窗口正在关闭，丢掉即可 */
  }
}

/** 把错误翻成给人看的一句话。 */
function humanError(error: unknown): string {
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

export function registerAiIpc(): void {
  ipcMain.handle(AI_CHANNEL.listProviders, () => listProvidersWithProbe());

  /**
   * 主动探测各 provider 真实连通性。
   * 不在启动时自动跑（会拖慢启动 + 白烧额度），只在用户需要时触发。
   */
  ipcMain.handle(AI_CHANNEL.probe, () => probeProviders());

  /**
   * 用户点了「允许」→ 执行那一次被拦下的工具调用（§144）。
   *
   * 这里**不再过闸门**：用户已经批过了，再判一次 `ask` 只会永远拦着。
   * 界面要显示的那一行在这里生成（`describeToolResult`），前端不重算 ——
   * 否则"文案口径"会分裂成两份。
   */
  ipcMain.handle(AI_CHANNEL.runTool, async (_event, request: ToolRunRequest): Promise<ToolRunResult> => {
    /*
     * 放行时给一个**默认 provider**（§150）：父请求的上下文早就结束了。
     * 对子智能体来说这不影响语义（它用自己的上下文跑），
     * 所以取当前第一个可用 provider 就够 —— 拿不到就空着，交给执行体报错。
     */
    const first = (await listProvidersWithProbe())?.[0];
    const env: ToolEnv = {
      mode: request.toolPolicy ?? "全部允许",
      provider: first?.id ?? "",
      ...(first?.models?.[0] ? { model: first.models[0] } : {}),
      depth: 0,
    };
    const res = await runToolOnce(request.name, request.input, env);
    return { ...res, line: describeToolResult(request.name, res.ok, res.output, res.error) };
  });

  ipcMain.handle(AI_CHANNEL.abort, (_event, requestId: string) => {
    liveStreams.get(requestId)?.controller.abort();
    return { ok: true };
  });

  ipcMain.handle(AI_CHANNEL.chat, async (event, request: ChatRequest) => {
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sender = event.sender;

    const provider = getProvider(request.provider);
    if (!provider) {
      const message = `未知 provider：${request.provider}`;
      safeSend(sender, { requestId, type: "error", message });
      return { requestId, ok: false, error: message };
    }

    const apiKey = resolveSecret(provider.keyRef);
    if (!apiKey) {
      const message = `${provider.label} 没有可用密钥（需要 ${provider.keyRef}）`;
      safeSend(sender, { requestId, type: "error", message });
      return { requestId, ok: false, error: message };
    }

    const model =
      request.model && provider.models.includes(request.model) ? request.model : provider.models[0];

    const controller = new AbortController();
    liveStreams.set(requestId, { controller });

    // 流式转发在后台跑：调用方立刻拿到 requestId 用于订阅与中止
    void (async () => {
      let buffered = "";
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (buffered) {
          safeSend(sender, { requestId, type: "text", text: buffered });
          buffered = "";
        }
      };

      try {
        const client = createOpenAICompatible({
          name: provider.id,
          baseURL: provider.baseURL,
          apiKey,
        });

        const result = streamText({          model: client(model),
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          system: request.system,
          temperature: request.temperature,
          maxOutputTokens: request.maxTokens,
          abortSignal: controller.signal,
          /*
           * ── 工具协议（§141）────────────────────────────────────────────
           *
           * `tools`：把共享层的声明交给模型。**执行在主进程**（`./tools`），
           * 渲染进程绕不过去 —— 这是后面「审批闸门」能只在**一个地方**做的前提。
           *
           * `stopWhen: stepCountIs(4)`：这是"模型调完工具、拿到结果、继续把话说完"的
           * 那几轮。老写法（只调一次模型）会让工具调用的结果**永远回不到模型嘴里**。
           * 4 步是按 12-factor 那句"超过 10–20 轮就烂"取的保守值：够一次工具往返 + 收尾，
           * 又不至于让模型在里面打转。
           *
           * 工具执行抛错**不会**中断这次流：AI SDK 把它变成 `tool-error`，
           * 我们照样把它当一次工具结果转发（goose / Factor 9 的口径：错误也要当结果回注）。
           */
          /*
           * 工具**只在发起方明确要求时才带**（§143）。
           *
           * 起标题、翻译这类附带请求与回答是并行的，它们拿到工具集就会真的执行动作
           * —— 一次发送写两次记忆就是这么来的。默认不带，是这里唯一安全的默认值。
           */
          ...(request.useTools
            ? {
                tools: agentTools({ mode: request.toolPolicy ?? "全部允许", provider: provider.id, model, depth: 0 }),
                stopWhen: stepCountIs(4),
              }
            : {}),
        });

        /*
         * ⚠️ 这里从 `textStream` 换成 `fullStream`。
         *
         * `textStream` 只有文本增量，**看不见工具调用**；而"模型调了什么、结果如何"
         * 正是要记进这一步（step 事件化）的东西。换掉之后文本的处理方式不变
         * （仍是 40ms 攒一批发出去），只是多接了两类事件。
         */
        for await (const part of result.fullStream) {
          if (controller.signal.aborted) break;
          if (part.type === "text-delta") {
            buffered += part.text;
            if (!flushTimer) flushTimer = setTimeout(flush, 40);
            continue;
          }
          if (part.type === "tool-call") {
            /*
             * 工具调用事件要**先把自己攒的文本发出去**：不然界面上会出现
             * "模型说了一半 → 工具执行 → 后半句"，而那半句还压在缓冲里没发。
             */
            flush();
            safeSend(sender, {
              requestId,
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            });
            continue;
          }
          if (part.type === "tool-result" || part.type === "tool-error") {
            flush();
            const failed = part.type === "tool-error";
            safeSend(sender, {
              requestId,
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              ...(failed
                ? { error: part.error instanceof Error ? part.error.message : String(part.error) }
                : { output: part.output }),
            });
            continue;
          }
          if (part.type === "error") {
            throw part.error;
          }
        }
        flush();

        if (!controller.signal.aborted) {
          let usage: { inputTokens?: number; outputTokens?: number } | undefined;
          try {
            const final = await result.usage;
            usage = { inputTokens: final.inputTokens, outputTokens: final.outputTokens };
          } catch {
            usage = undefined;
          }
          // 真的跑通了 —— 把这家 provider 标成"已验证"（界面上才敢说可用）
          markProviderOk(provider.id);
          safeSend(sender, { requestId, type: "done", usage });
        }
      } catch (error) {
        flush();
        const message = humanError(error);
        // 不是"中止"才算失败：中止是用户意图，不该把 provider 判死
        if (!controller.signal.aborted) markProviderFailed(provider.id, message);
        safeSend(sender, { requestId, type: "error", message });
      } finally {
        liveStreams.delete(requestId);
      }
    })();

    return { requestId, ok: true, provider: provider.id, model };
  });
}
