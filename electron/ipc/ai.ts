import { ipcMain, type WebContents } from "electron";
import { healthStore, listProvidersWithProbe, probeProviders } from "./aiProbe";
import { desktopSessionStore } from "./sessionStore";
import { hostExecutor, mcpToolEntries, runToolOnce, type ToolEnv } from "./tools";
import { describeToolResult, rejectedLine } from "../../shared/agentTools";
import { createEngine } from "../../engine/index";
import type { LogInput } from "../../engine/core/events";
import { humanError, resolveTurnTarget, type TurnEvent } from "../../engine/runtime/loop";
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

/*
 * 会话存储从**端口**拿（`electron/ipc/sessionStore.ts`）。Phase 4.3 起它是 SQLite；
 * 换实现时这里一行都不用改 —— 这正是端口存在的理由。
 *
 * ⚠️ 用**函数**而不是模块级常量：库的路径取决于 `app.getPath("userData")`，
 * 而主进程要先 `app.setPath`（数据目录覆盖 / 开发态）才定下来，
 * 那一步发生在模块求值**之后**。模块加载时就建库 = 库落到默认目录里。
 */

/**
 * 往会话日志补一条记录（宿主侧的唯一补记入口：闸门决策）。
 *
 * ⚠️ 没有 `sessionId` 时**什么都不做**（那一轮不属于任何会话）；
 * 写失败也**不抛给调用方** —— 用户点「允许」这件事本身不该因为日志写不进去而失败。
 *
 * @param sessionId 会话 id（可能没给）
 * @param record 要补记的记录
 */
async function storeAppend(sessionId: string | undefined, record: LogInput): Promise<void> {
  if (!sessionId) return;
  try {
    await desktopSessionStore().append(sessionId, [record]);
  } catch (error) {
    console.error("[session] 补记失败（不影响这次操作）：", error instanceof Error ? error.message : error);
  }
}

/** 渲染进程可能已经刷新/关闭，发送前确认目标还在。 */
function safeSend(sender: WebContents, event: AiStreamEvent): void {
  if (sender.isDestroyed()) return;
  try {
    sender.send(AI_CHANNEL.stream, event);
  } catch {
    /* 窗口正在关闭，丢掉即可 */
  }
}

/*
 * ⚠️ "这一轮下发给模型的工具名"（`offeredToolNames`）**搬进内核了**
 * （`engine/runtime/registry.ts`），日志也由内核自己写 ——
 * 它在装配工具集与写 `request` 记录时用的是同一个注册表，两边不可能对不上。
 * 主进程这里不再重算一份（重算就是"同一件事的第二份实现"）。
 */

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
        /*
         * 走**同一个 store 端口**（不再直接抓写入器）：决策记录与事件流必须落在
         * 同一条编号序列上 —— 两个写入器各数一遍 seq 的后果，是重启后这条留痕
         * 永远停在"等确认"（实测过）。
         */
        await storeAppend(request.sessionId, {
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
      await storeAppend(request.sessionId, {
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
     * ── 解析目标（必须在**同步返回**之前做完）──────────────────────
     *
     * 渲染层拿 `{provider, model}` 显示"这次用的谁"，所以这一步不能挪进异步体。
     * 规则只有一份（`resolveTurnTarget`），引擎内部用的也是它。
     */
    const target = resolveTurnTarget(request.provider, request.model);
    if (!target.ok) {
      /*
       * 连 provider 都没解析出来 —— 这一轮**没跑**，引擎不会介入（它连注册表都没见过）。
       * 所以这条错误由宿主自己记：不记的话，日志里会缺一次"用户发了话、什么都没发生"。
       */
      await desktopSessionStore()
        .append(request.sessionId ?? "", [{ requestId, type: "error", message: target.error }])
        .catch(() => undefined);
      safeSend(sender, { requestId, type: "error", message: target.error });
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
          safeSend(sender, { requestId, type: "text", text: buffered });
          buffered = "";
        }
      };

      /** 内核的事件 → IPC 事件（**只在这里补 requestId**；其余字段一一对应 —— 传输耦合只留这里）。 */
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

      /*
       * 引擎**每一轮现建**：MCP 的连接器工具是运行时才出现的（用户随时可以接上一个），
       * 而注册表在 `createEngine` 时快照一次。装配本身不碰 IO，代价可忽略。
       */
      const engine = createEngine({
        store: desktopSessionStore(),
        executor: hostExecutor,
        health: healthStore,
        tools: mcpToolEntries(),
      });

      try {
        await engine.run({
          sessionId: request.sessionId,
          provider: request.provider,
          model: target.model,
          ...(request.system ? { system: request.system } : {}),
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          mode: request.toolPolicy ?? "全部允许",
          ...(request.useTools ? { useTools: true } : {}),
          abortSignal: controller.signal,
          /*
           * ⚠️ 这个出口只负责**上屏**：请求记录、每一次工具调用、用量、中止与错误
           * 全部由**引擎自己写进会话日志**（它在同一个 emit 点做，所以界面看到的
           * 与日志里记的顺序一致）。宿主不再另写一份 —— 那正是 C2 收敛掉的东西。
           */
          onEvent: (e) => {
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
            if (mapped) safeSend(sender, mapped);
          },
        });
        flush();
        /*
         * 被用户中止：主进程**不发**事件（渲染层那边的 `abort()` 已经本地收尾了）。
         * 日志里那条终止记录由**引擎**写（它知道 outcome.aborted）——
         * 宿主只负责不发。
         */
      } catch (error) {
        // 引擎自己已经把错误翻成事件了；这里只是"连事件都没能发出去"时的兜底
        flush();
        safeSend(sender, { requestId, type: "error", message: humanError(error) });
      } finally {
        liveStreams.delete(requestId);
      }
    })();

    return { requestId, ok: true, provider: target.provider.id, model: target.model };
  });
}
