import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { RpcMessage } from "./agent";

/**
 * **ACP 客户端**（V6-3f）：让 Ding 去驱动**外部** agent。
 *
 * ## 两个方向，一套协议
 *
 * 原来只有 `hosts/acp/agent.ts`：Ding 作为 agent 被 OpenHands/编辑器驱动。
 * 这一份是反方向 —— Ding 作为 **client**，把任务交给别的 ACP agent
 * （Claude Code、别的 harness、团队自研 agent）。协议是同一套 JSON-RPC 2.0 / stdio，
 * 所以两边的消息形状共用 `RpcMessage`。
 *
 * ## 远程 ACP 的补位（如实说）
 *
 * ACP 官方远程传输还是 WIP。Ding 现成的答案是 **E2EE 中继**（V5-2）：
 * 控制流走中继明文（可路由、可审计），内容走内容层加密。
 * 这一份先做**本地 stdio**（协议今天就能跑的那一半）；远程由 `ding serve` + 中继承担。
 *
 * ## 失败口径
 *
 * - 起不来 / 握手失败 / 请求超时 → 抛错（调用方给一句能照着做的话）；
 * - 一轮失败 → `session/prompt` 的 JSON-RPC error（协议里没有 "error" 型 update）；
 * - stderr 原样保留，出错时附在消息里（**不吞**）。
 */

export type AcpClientOptions = {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 单个请求的超时（默认 120s；`initialize` 也算）。 */
  timeoutMs?: number;
  log?: (line: string) => void;
};

/** agent 发来的 `session/update` 通知。 */
export type AcpUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** 一个运行中的外部 ACP agent。 */
export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly updateHandlers = new Set<(update: AcpUpdate) => void>();
  private stderrText = "";
  private closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
    private readonly log: (line: string) => void,
  ) {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrText += text;
      /* 只留最后 8KB，避免一个话痨 agent 把内存吃光 */
      if (this.stderrText.length > 8192) this.stderrText = this.stderrText.slice(-8192);
      for (const line of text.split("\n")) if (line.trim()) this.log(`[agent] ${line}`);
    });
    const failAll = (why: string) => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(why));
      }
      this.pending.clear();
    };
    child.on("error", (error) => failAll(`外部 agent 起不来：${error.message}`));
    child.on("exit", (code, signal) => {
      failAll(`外部 agent 退出（code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}）`);
    });
  }

  /** 起一个外部 agent（不自动握手；先调 `initialize`）。 */
  static spawn(opts: AcpClientOptions): AcpClient {
    const child = spawn(opts.command, [...(opts.args ?? [])], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const log = opts.log ?? (() => undefined);
    const client = new AcpClient(child, opts.timeoutMs ?? 120_000, log);
    child.on("error", (error) => log(`[agent] 起不来：${error.message}`));
    return client;
  }

  /** 订阅 `session/update`（返回取消订阅）。 */
  onUpdate(handler: (update: AcpUpdate) => void): () => void {
    this.updateHandlers.add(handler);
    return () => this.updateHandlers.delete(handler);
  }

  /** agent 的 stderr（出错时附在消息里）。 */
  stderr(): string {
    return this.stderrText.trim();
  }

  private handleLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(text) as RpcMessage;
    } catch {
      this.log(`[agent] 非 JSON 输出（已忽略）：${text.slice(0, 120)}`);
      return;
    }
    if (message.method === "session/update") {
      const params = (message.params ?? {}) as { sessionId?: unknown; update?: unknown };
      const update = {
        sessionId: String(params.sessionId ?? ""),
        update: (params.update ?? {}) as Record<string, unknown>,
      };
      for (const handler of this.updateHandlers) handler(update);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${message.error.message}（code ${message.error.code}）`));
      else pending.resolve(message.result);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("外部 agent 已经退出了"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时（${method}，${this.timeoutMs}ms 没有回应）`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`写不进去（${method}）：${String((error as Error)?.message ?? error)}`));
      }
    });
  }

  /** 握手。 */
  async initialize(): Promise<Record<string, unknown>> {
    const result = (await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} })) as Record<string, unknown>;
    return result ?? {};
  }

  /** 开一段会话，返回 agent 侧的 sessionId。 */
  async newSession(cwd: string): Promise<string> {
    const result = (await this.request("session/new", { cwd, mcpServers: [] })) as { sessionId?: unknown };
    const sessionId = String(result?.sessionId ?? "");
    if (!sessionId) throw new Error("agent 的 session/new 没有回 sessionId");
    return sessionId;
  }

  /** 发一轮提示词；返回 stopReason。更新通过 `onUpdate` 到达。 */
  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const result = (await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    })) as { stopReason?: unknown };
    return { stopReason: String(result?.stopReason ?? "unknown") };
  }

  /** 取消正在跑的一轮（通知，无结果）。 */
  cancel(sessionId: string): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }) + "\n");
  }

  /** 关掉子进程。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* 已经关了 */
    }
    /* 给 agent 一点收尾时间，然后强杀（不留孤儿进程） */
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {
          /* 已经退出 */
        }
        resolve();
      }, 1500);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
