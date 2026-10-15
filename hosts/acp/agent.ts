import type { Engine } from "../../engine/index";
import type { TurnEvent } from "../../engine/runtime/loop";
import type { ConfirmMode } from "../../shared/ipc";
import { humanFailure } from "../../shared/errors";
import { PRODUCT_NAME, PRODUCT_TITLE, PRODUCT_VERSION } from "../../shared/product";
import { CwdNotAllowedError } from "../cwd";
import type { CwdDecision } from "../cwd";

/**
 * ACP 宿主（Phase 17）——让外部客户端（OpenHands 之类）能驱动我们。
 *
 * ## 协议形状从哪来的（不是猜的）
 *
 * ACP = Agent Client Protocol，JSON-RPC 2.0，**agent 作为 client 的子进程**跑，
 * 走标准输入输出。方法名与字段名照官方文档（`agentclientprotocol.com/protocol/schema`）：
 *
 * | 方向 | 方法 | 关键字段 |
 * |---|---|---|
 * | client → agent | `initialize` | `protocolVersion` / `clientCapabilities` |
 * | client → agent | `session/new` | `cwd`（绝对路径）/ `mcpServers` → 回 `{ sessionId }` |
 * | client → agent | `session/prompt` | `sessionId` / `prompt: ContentBlock[]` → 回 `{ stopReason }` |
 * | agent → client | `session/update`（通知） | `sessionId` / `update.sessionUpdate` |
 * | client → agent | `session/cancel`（通知） | `sessionId` |
 *
 * ⚠️ **三处如实说明**（文档里没写死、我不编）：
 *   1. `StopReason` 的**取值表**在那一页没有列全 —— 这里只发 `end_turn` / `cancelled`
 *      两个（社区实现里最常见的那两个），并靠调用方容错；
 *   2. `update.sessionUpdate` 的判别串同理，这里只发 `agent_message_chunk`（正文）
 *      与 `tool_call` / `tool_call_update` 三种，其它类型不发
 *      （宁可不发，也不发一个形状可疑的）；
 *   3. **失败不走 `session/update`**：那个类型表里没有 "error"，所以一轮的失败
 *      用 `session/prompt` 的 **JSON-RPC error 响应**报 —— 那是对端一定会看到的通道
 *      （原来把错误只写 stderr，GUI 宿主看不见，等于把失败报成成功）。
 *
 * ## 与内核的关系：**一份引擎，两个宿主**
 *
 * 这里不碰任何 agent 逻辑：ACP 的每一轮都是 `engine.run` —— 与 CLI、桌面同一条路。
 * 于是"接入外部宿主后评测集零漂移"是**结构上成立**的（同一份内核 + 同一套判据），
 * 不是靠"接完之后再跑一遍看看"。
 */

/** JSON-RPC 2.0 的请求 / 通知 / 响应。 */
export type JsonRpcId = string | number | null;

export type RpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** 我们支持的协议版本（ACP 用日期或语义化版本表达；这里只声明我们认的那一个）。 */
export const ACP_PROTOCOL_VERSION = 1;

/** 一个 ACP 会话（我们这边的状态）。 */
type AcpSession = {
  /** 客户端给的工作目录（ACP 要求绝对路径）。 */
  cwd: string;
  /** 我们这边的会话 id（进内核日志的那个）。 */
  sessionId: string;
  /** 正在跑的那一轮（`session/cancel` 要能中止它）。 */
  abort: AbortController | null;
};

/** 宿主给这一层的依赖（**注入**，所以协议层能被单测一遍遍跑）。 */
export type AcpDeps = {
  /** 现建一个引擎（工作目录 → 引擎）。与 `hosts/cli` 的装配同一份。 */
  makeEngine: (cwd: string) => Promise<{ engine: Engine; close: () => void }>;
  /**
   * 工作目录授权（2026-10-16，审计 P181）：外部客户端给的 cwd 必须先过这一关。
   * 不给 = 不校验（单测与嵌入式用法）；`ding acp` 一直给。
   */
  authorizeCwd?: (raw: string) => CwdDecision;
  /** 闸门档位（宿主决定；ACP 客户端目前不能改我们的档位）。 */
  mode: ConfirmMode;
  /** provider / model（宿主解析后的）。 */
  provider: string;
  model?: string;
  /** 发一条消息给客户端（协议层不管怎么写出去）。 */
  send: (message: RpcMessage) => void;
  /** 记一条日志（写 stderr；**不能写 stdout** —— 那是协议通道）。 */
  log?: (line: string) => void;
};

/**
 * 一行输入的字节上限（审计 P185）。
 *
 * 原来没有上限：`JSON.parse` 对**整行**一次性解析，行有多长就吃多少内存 ——
 * 而这一行的长度由对端决定。超限的判为解析错误（协议层面本来就解析不了），
 * 但**不中止**这个进程：后面还有正常的行要处理。
 */
const MAX_LINE_CHARS = 1_000_000;

/**
 * 会话数上限（审计 P185）。
 *
 * `sessions` 原来只增不减 —— 对端只要一直 `session/new` 就能把内存吃光。
 * 说清淘汰口径：**优先淘汰最旧的空闲会话**（正在跑一轮的一条都不动）；
 * 全都在跑就明确拒绝新的 `session/new`（比悄悄挤掉一个正在跑的好）。
 */
const MAX_SESSIONS = 64;

/**
 * 一个 ACP agent（协议层）。
 *
 * 用法：`handleLine(一行 JSON)` → 它自己通过 `deps.send` 回消息。
 */
export class AcpAgent {
  private readonly sessions = new Map<string, AcpSession>();
  private seq = 0;

  constructor(private readonly deps: AcpDeps) {}

  /** 处理一行输入（不是 JSON / 不是 JSON-RPC 就回一条错误，而不是崩）。 */
  async handleLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;
    if (text.length > MAX_LINE_CHARS) {
      this.deps.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `这一行太长（上限 ${MAX_LINE_CHARS} 字符）：拒绝解析` },
      });
      return;
    }
    let message: RpcMessage;
    try {
      message = JSON.parse(text) as RpcMessage;
    } catch {
      this.deps.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "解析失败：这一行不是 JSON" } });
      return;
    }
    await this.handle(message);
  }

  private async handle(message: RpcMessage): Promise<void> {
    const { method, id } = message;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const isNotification = id === undefined;

    switch (method) {
      case "initialize":
        return this.reply(id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            /* 我们能加载已有会话（内核有 resume） */
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          agentInfo: { name: PRODUCT_NAME, title: PRODUCT_TITLE, version: PRODUCT_VERSION },
        });

      case "session/new": {
        const cwd = String(params.cwd ?? "").trim();
        if (!cwd) return this.fail(id, -32602, "session/new 需要 cwd（绝对路径）");
        /*
         * ⚠️ 授权**在开门这一层**就判（审计 P181）：原来任意非法/未授权路径都照样
         * `openSession` 回一个 sessionId，失败要等到 `session/prompt` 才暴露 ——
         * 那时候客户端已经在按"会话建好了"往下走了。
         */
        const decision = this.deps.authorizeCwd?.(cwd) ?? { ok: true as const, cwd };
        if (!decision.ok) return this.fail(id, -32602, decision.reason);
        return this.openSession(id, decision.cwd);
      }

      case "session/prompt":
        return this.prompt(id, params);

      case "session/cancel": {
        /* 通知（没有 id）：中止那一轮。中止是用户意图，不判失败 */
        const sessionId = String(params.sessionId ?? "");
        const session = this.sessions.get(sessionId);
        session?.abort?.abort();
        return;
      }

      default:
        if (isNotification) return; // 不认识的**通知**：按协议忽略（不能回错误，通知没有 id）
        return this.fail(id, -32601, `不认识的方法：${String(method)}`);
    }
  }

  /** 建一段会话（回 `sessionId`）。 */
  private async openSession(id: JsonRpcId | undefined, cwd: string): Promise<void> {
    if (this.sessions.size >= MAX_SESSIONS) {
      /*
       * 满了：先淘汰**最旧的空闲会话**（没有在跑一轮的那些）。全都在跑就拒新的 ——
       * 悄悄挤掉一个正在跑的会话，会让对端正跑着的那一轮凭空消失。
       */
      const idle = [...this.sessions.entries()].find(([, s]) => s.abort === null);
      if (!idle) return this.fail(id, -32000, `会话数已达上限（${MAX_SESSIONS}），且都在跑：先 cancel 一些再建新的`);
      this.sessions.delete(idle[0]);
      this.deps.log?.(`会话数达上限：淘汰最旧的空闲会话 ${idle[0]}`);
    }
    const sessionId = `acp-${Date.now().toString(36)}-${(this.seq += 1)}`;
    this.sessions.set(sessionId, { cwd, sessionId, abort: null });
    this.reply(id, { sessionId });
  }

  /** 跑一轮（流式推 `session/update`，最后回 `stopReason`）。 */
  private async prompt(id: JsonRpcId | undefined, params: Record<string, unknown>): Promise<void> {
    const acpSessionId = String(params.sessionId ?? "");
    const session = this.sessions.get(acpSessionId);
    if (!session) return this.fail(id, -32602, `没有这段会话：${acpSessionId}`);

    /*
     * 同一段会话不许并发跑两轮：`session.abort` 非空就是"正跑着"。
     * 拒绝比排队好 —— 排队会让对端以为第二句话已经在处理了。
     */
    if (session.abort) return this.fail(id, -32603, `这段会话正跑着一轮：先 session/cancel 再发`);

    const text = textOfPrompt(params.prompt);
    if (!text.trim()) return this.fail(id, -32602, "prompt 是空的（至少给一段文本）");

    const abort = new AbortController();
    session.abort = abort;
    let built: Awaited<ReturnType<AcpDeps["makeEngine"]>> | null = null;
    try {
      built = await this.deps.makeEngine(session.cwd);
      const outcome = await built.engine.run({
        sessionId: session.sessionId,
        provider: this.deps.provider,
        ...(this.deps.model ? { model: this.deps.model } : {}),
        messages: [{ role: "user", content: text }],
        mode: this.deps.mode,
        useTools: true,
        maxSteps: 8,
        abortSignal: abort.signal,
        onEvent: (event) => this.notifyUpdate(acpSessionId, event),
      });
      if (!outcome.ok && !outcome.aborted) {
        /*
         * ⚠️ 失败**如实报失败**（审计 P177）。ACP 的 `session/update` 里
         * **没有** "error" 这个类型（见文件头第 2 条：形状不编），所以失败走
         * JSON-RPC error 这条对端一定会看到的通道 —— 话术仍是 Phase 13.1 那份
         * 人话，由 `humanFailure` 翻好再送。
         */
        this.fail(id, -32603, humanFailure(outcome.error ?? "这一轮没有跑成"));
        return;
      }
      this.reply(id, { stopReason: outcome.aborted ? "cancelled" : "end_turn" });
    } catch (error) {
      /*
       * ⚠️ 内部异常必须**如实报失败**（审计 P177）：原来这里回一个与成功完全同形
       * 的 `{stopReason:"end_turn"}`，错误只写 stderr —— 而 stderr 由客户端决定
       * 看不看得见，多数 GUI 宿主不显示。于是"这一轮炸了"在对端等于"这一轮答完了"。
       */
      const reason = error instanceof CwdNotAllowedError ? error.message : humanFailure(String((error as Error)?.message ?? error));
      this.fail(id, -32603, `这一轮出错：${reason}`);
      this.deps.log?.(`ACP 这一轮出错：${reason.slice(0, 200)}`);
    } finally {
      session.abort = null;
      built?.close();
    }
  }

  /** 把内核事件翻成 ACP 的 `session/update` 通知。 */
  private notifyUpdate(sessionId: string, event: TurnEvent): void {
    /*
     * ⚠️ 只翻两种（见文件头第 2 条）：正文与工具调用。
     * 别的（步骤、用量、委派）**不发** —— 发了的话形状是我编的，
     * 外部宿主按规范解析会得到一堆它不认识的东西。
     */
    if (event.type === "text") {
      this.deps.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } } },
      });
      return;
    }
    if (event.type === "tool-call") {
      this.deps.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: event.toolCallId,
            title: event.toolName,
            status: "in_progress",
            rawInput: event.input,
          },
        },
      });
      return;
    }
    if (event.type === "tool-result") {
      /*
       * ⚠️ 被闸门拦下的工具**对外是失败**，不是"完成"（审计 P176）。
       * 闸门拦下时工具返回的是 `{ pending: true, notice: "已把这次…交给用户确认……还没有执行" }`
       * —— 它**没有 `error` 字段**，只按 `error` 判就会把"没执行"上报成 `completed`，
       * 外部宿主界面上那条工具调用会显示成绿的。
       */
      const pending =
        typeof event.output === "object" && event.output !== null && (event.output as { pending?: unknown }).pending === true;
      this.deps.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: event.error || pending ? "failed" : "completed",
          },
        },
      });
    }
  }

  private reply(id: JsonRpcId | undefined, result: unknown): void {
    if (id === undefined) return; // 通知不需要回
    this.deps.send({ jsonrpc: "2.0", id, result });
  }

  private fail(id: JsonRpcId | undefined, code: number, message: string): void {
    if (id === undefined) return;
    this.deps.send({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

/**
 * 从 ACP 的 `prompt` 里取出文本。
 *
 * 基线只要求支持 `text` 与 `resource_link` 两种 ContentBlock；
 * 别的类型（图片/音频）**忽略但不报错**（我们不支持它们，声明过了）。
 */
export function textOfPrompt(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  const parts: string[] = [];
  for (const block of prompt) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown; uri?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    /* `resource_link`：把链接当成一句话交进去（我们不做资源解析） */
    else if (b.type === "resource_link" && typeof b.uri === "string") parts.push(`[资源] ${b.uri}`);
  }
  return parts.join("\n");
}
