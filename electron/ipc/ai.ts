import { ipcMain, type WebContents } from "electron";
import { listProvidersWithProbe, probeProviders } from "./aiProbe";
import { getSessionLogger } from "./sessionStore";
import { agentTools, runToolOnce, type ToolEnv } from "./tools";
import { describeToolResult, rejectedLine } from "../../shared/agentTools";
import { humanError, resolveTurnTarget, runTurn, type TurnEvent } from "./runTurn";
import type { AiStreamEvent, ChatRequest, ToolRunRequest, ToolRunResult } from "../../shared/ipc";
import type { ConfirmMode } from "../../shared/ipc";

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

/**
 * 这一轮**会下发给模型**的工具名（与真正构造工具集时用同一套判定）。
 *
 * 为什么要有它：日志里只记"用没用工具"是看不出"够得着什么"的 ——
 * 新加的工具到底有没有下发、某个档位下是不是被隐藏了，都得有个可查的记录。
 *
 * @param request 渲染进程给的这次请求
 * @returns 工具名列表；不带工具时是空数组
 */
function offeredToolNames(request: { useTools?: boolean; toolPolicy?: ConfirmMode }): string[] {
  if (!request.useTools) return [];
  const mode = request.toolPolicy ?? "全部允许";
  return Object.keys(agentTools({ mode, provider: "", depth: 0 }));
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
     * ── 拒绝：不执行，只把决定记进日志（INV-3）──────────────────────
     *
     * 原来"拒绝"是**纯渲染层**的动作：连 IPC 都不发。后果是重启之后
     * 那条留痕又变回「等你确认」（用户明明拒过），而"谁拒的、拒了什么"也**无从查证**。
     * 现在它走同一个通道、落同一条决策记录 —— 与批准对称。
     */
    if (request.reject) {
      const line = rejectedLine(request.name);
      if (request.toolCallId) {
        getSessionLogger(request.sessionId)?.log({
          type: "approval",
          toolCallId: request.toolCallId,
          name: request.name,
          approved: false,
          line,
        });
      }
      return { ok: true, line };
    }

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
    const line = describeToolResult(request.name, res.ok, res.output, res.error);
    /*
     * 批准：把**决定与结果一起**记进日志（INV-3）。
     * 记结果是因为重放日志时要能还原成"已保存，当前 N 条"那一行 ——
     * 只记"批过了"的话，重启后那条留痕会变成一个没有内容的空壳。
     */
    if (request.toolCallId) {
      getSessionLogger(request.sessionId)?.log({
        type: "approval",
        toolCallId: request.toolCallId,
        name: request.name,
        approved: true,
        ok: res.ok,
        ...(res.output === undefined ? {} : { output: res.output }),
        ...(res.error ? { error: res.error } : {}),
        line,
      });
    }
    return { ...res, line };
  });

  ipcMain.handle(AI_CHANNEL.abort, (_event, requestId: string) => {
    liveStreams.get(requestId)?.controller.abort();
    return { ok: true };
  });

  ipcMain.handle(AI_CHANNEL.chat, async (event, request: ChatRequest) => {
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sender = event.sender;

    /*
     * ── 会话日志（C2）──────────────────────────────────────────────
     *
     * 主进程是**唯一**知道"这一轮完整发生了什么"的地方：请求体、每一次工具调用、
     * 真实用量、中止与错误。原来这些发完即丢，事后只能靠渲染层那份"渲染后的样子"去猜。
     *
     * 所以：**发与记在同一处**（下面的 `emit`）—— 两处各写一份必然会漂移，
     * 而"日志说调了工具、界面没显示"这种不一致最难查。
     *
     * ⚠️ 用 `getSessionLogger`（**同一会话共用一个**）：用户点「允许」时
     * `ai:runTool` 要往**同一个文件**写决策记录，两个写入器各自从 seq=1 数就会撞号。
     */
    const sessionLog = getSessionLogger(request.sessionId);
    sessionLog?.log({
      requestId,
      type: "request",
      provider: request.provider,
      model: request.model ?? "",
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(request.toolPolicy ? { toolPolicy: request.toolPolicy } : {}),
      ...(request.useTools ? { useTools: true } : {}),
      /*
       * **这一轮给了模型哪些工具**（2026-10-14 补）。
       *
       * 以前日志只记了"用没用工具"（`useTools: true`）与档位 —— 于是事后没人知道
       * 模型当时**够得着什么**：一个新加的工具到底有没有被下发？只能靠复现。
       * 名字列表很小，记下来之后这类问题一条日志就能回答，
       * 顺带让"工具被正确注入"这件事**可断言**（不需要模型真的调用它）。
       */
      tools: offeredToolNames(request),
    });
    /** 发给渲染进程的同时记进日志（**唯一**的事件出口）。 */
    const emit = (e: AiStreamEvent): void => {
      sessionLog?.log(e);
      safeSend(sender, e);
    };

    /*
     * 解析目标要在**同步返回**之前做完：渲染层拿 `{provider, model}` 显示"这次用的谁"。
     * 规则只有一份（`resolveTurnTarget`），下面 `runTurn` 内部用的也是它。
     */
    const target = resolveTurnTarget(request.provider, request.model);
    if (!target.ok) {
      emit({ requestId, type: "error", message: target.error });
      return { requestId, ok: false, error: target.error };
    }

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
          emit({ requestId, type: "text", text: buffered });
          buffered = "";
        }
      };

      /** 主循环的事件 → IPC 事件（**只在这里补 requestId**；其余字段一一对应）。 */
      const toStreamEvent = (e: TurnEvent): AiStreamEvent | null => {
        if (e.type === "text") return { requestId, type: "text", text: e.text };
        if (e.type === "tool-call") {
          return { requestId, type: "tool-call", toolCallId: e.toolCallId, toolName: e.toolName, input: e.input };
        }
        if (e.type === "tool-result") {
          return {
            requestId,
            type: "tool-result",
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            ...(e.output === undefined ? {} : { output: e.output }),
            ...(e.error ? { error: e.error } : {}),
          };
        }
        if (e.type === "done") return { requestId, type: "done", ...(e.usage ? { usage: e.usage } : {}) };
        if (e.type === "error") return { requestId, type: "error", message: e.message };
        return null; // step-finish：只用来数步数，不进 IPC
      };

      try {
        const outcome = await runTurn(
          {
            provider: request.provider,
            model: target.model,
            ...(request.system ? { system: request.system } : {}),
            messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            abortSignal: controller.signal,
            /*
             * 工具**只在发起方明确要求时才带**（§143）。
             *
             * 起标题、翻译这类附带请求与回答是并行的，它们拿到工具集就会真的执行动作
             * —— 一次发送写两次记忆就是这么来的。默认不带，是这里唯一安全的默认值。
             *
             * ⚠️ `signal` 也放进 env：它一路传到 `spawn_agent` → 子智能体（C2-3）。
             */
            ...(request.useTools
              ? {
                  tools: agentTools({
                    mode: request.toolPolicy ?? "全部允许",
                    provider: target.provider.id,
                    model: target.model,
                    depth: 0,
                    signal: controller.signal,
                  }),
                  // 步数上限：父级 4（子智能体 6）—— **参数，不是两条代码路径**
                  maxSteps: 4,
                }
              : {}),
          },
          (e) => {
            if (e.type === "text") {
              // 40ms 一批：一个字一次 IPC 会把渲染进程淹掉
              buffered += e.text;
              if (!flushTimer) flushTimer = setTimeout(flush, 40);
              return;
            }
            /*
             * 工具事件要**先把自己攒的文本发出去**：不然界面上会出现
             * "模型说了一半 → 工具执行 → 后半句"，而那半句还压在缓冲里没发。
             */
            flush();
            const mapped = toStreamEvent(e);
            if (mapped) emit(mapped);
          },
        );
        flush();
        /*
         * 被用户中止：主进程**不发**事件（渲染层那边的 `abort()` 已经本地收尾了），
         * 但**日志里要留下终止记录** —— 否则读日志的人分不清"这一轮断了"
         * 还是"这一轮还在跑"。所以这里只记不发。
         */
        if (outcome.aborted) sessionLog?.log({ requestId, type: "error", message: "已中止" });
      } catch (error) {
        // runTurn 自己已经把错误翻成事件了；这里只是"连事件都没能发出去"时的兜底
        flush();
        emit({ requestId, type: "error", message: humanError(error) });
      } finally {
        liveStreams.delete(requestId);
      }
    })();

    return { requestId, ok: true, provider: target.provider.id, model: target.model };
  });
}
