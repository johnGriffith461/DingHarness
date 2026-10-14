import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { McpServerConfig } from "../../shared/mcp";

/**
 * MCP 客户端（stdio 传输，2026-10-14）。
 *
 * ## 协议要点（照着 MCP 规范实现，不凭印象）
 *
 * - 传输是 **stdio 上的"一行一条 JSON"**（`\n` 分隔），**不是** LSP 那种
 *   `Content-Length` 头。写成后者会一个字节都通不了。
 * - 握手顺序：客户端发 `initialize`（带 `protocolVersion` / `clientInfo`）→
 *   服务端回它自己的 `protocolVersion` 与 `capabilities` → 客户端发
 *   `notifications/initialized`（**通知，没有 id、不等回）**。
 * - 然后才是 `tools/list` 与 `tools/call`。
 *
 * ## 这一层只做三件事
 * ① 把请求发出去、把回包对上号（id 匹配 + 超时）；
 * ② 服务端的**每个失败都变成"可读的一句话"**（Factor 9：错误要压缩进上下文，
 *    而不是抛异常把这一轮打断）；
 * ③ 进程死了要能自己发现，别让工具集里挂着一堆"点了就超时"的幽灵工具。
 *
 * ⚠️ 这里是主进程专用（`import node:child_process`），所以**不在 vitest 里直接测** ——
 * 它由 `src/workbench/mcpClient.test.ts` 用一个**真的**假 server 子进程端到端测，
 * 以及 `scripts/accept/accept-mcp.mjs` 在应用里测。
 */

/** 单条请求的超时（握手与列工具都短，调用工具给长一点）。 */
export type McpTimeouts = { handshakeMs: number; callMs: number };
const DEFAULT_TIMEOUTS: McpTimeouts = { handshakeMs: 15_000, callMs: 60_000 };

/** 服务端 stderr 留多少（诊断用；多了会占内存）。 */
const STDERR_KEEP = 4_000;

/** MCP 工具的描述（来自服务端）。 */
export type McpToolInfo = { name: string; description?: string; inputSchema?: unknown };

/** 连接状态。 */
export type McpStatus = "starting" | "on" | "error" | "off";

/** 一次调用的结果。 */
export type McpCallResult =
  | { ok: true; text: string; isError: boolean }
  | { ok: false; error: string };

/** JSON-RPC 的最小形状。 */
type RpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * 一个 MCP server 的连接。
 *
 * 生命周期由 `mcpStore` 管：`start()` → `listTools()` → 被调用若干次 → `stop()`。
 * 任何一个阶段失败都不抛给上层，而是把状态置成 `error` 并**把原因留着**
 * （界面上要看得见"为什么连不上"，不是一片空白）。
 */
export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (m: RpcMessage) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private stderrTail = "";
  private tools: McpToolInfo[] = [];
  private state: McpStatus = "off";
  private lastError = "";

  constructor(
    private readonly config: McpServerConfig,
    /* 可注入：单测要验“服务端不答会超时”，用真实值得等 15 秒 —— 那换不来任何东西 */
    private readonly timeouts: McpTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  /** 现在的状态。 */
  status(): McpStatus {
    return this.state;
  }

  /** 出问题时的原因（界面要显示它）。 */
  errorText(): string {
    return this.lastError || this.stderrTail.trim().split("\n").slice(-3).join("；");
  }

  /** 它现在交出来的工具。 */
  toolList(): McpToolInfo[] {
    return [...this.tools];
  }

  /**
   * 起进程并完成握手。
   *
   * @returns 连上了给 `true`；任何一步失败给 `false`（原因在 `errorText()`）
   */
  async start(): Promise<boolean> {
    if (this.config.enabled === false) {
      this.state = "off";
      return false;
    }
    this.state = "starting";
    try {
      /*
       * ⚠️ **自己在拼命令行**（2026-10-14 被集成测试逮到）。
       *
       * 第一版写的是 `spawn(command, args, { shell: true })` —— 在 Windows 上
       * `shell: true` 会把命令与参数拼成一行交给 cmd.exe，而
       * **带空格的路径不会被自动加引号**：`C:\Program Files\nodejs\node.exe`
       * 会被 cmd 读成 `C:\Program`，于是子进程立刻退出（退出码 1），
       * 表现成"连接器连不上"，而真因藏在引号里。
       *
       * 所以这里自己拼：含空格/特殊字符的部分逐个加引号，再整行交给 shell。
       * 这样 `npx.cmd` 这类脚本仍然能跑（要 shell），而带空格的路径也不会散架。
       */
      this.child = spawn(commandLine(this.config.command, this.config.args ?? []), {
        env: { ...process.env, ...(this.config.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // 服务端可能是个 .cmd / shell 脚本（Windows 上很常见），交给 shell 解析
        shell: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (e) {
      this.state = "error";
      this.lastError = `起不来：${e instanceof Error ? e.message : String(e)}`;
      return false;
    }

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_KEEP);
    });
    /*
     * ⭐ **给三个流都挂上 error 处理**（2026-10-14 被验收逮到）。
     *
     * 没有它的时候：服务端被 kill 之后，往它的 stdin 写一下就会发出 `EPIPE` ——
     * 而 Node 的规则是"**没有任何 error 监听的流一旦出错就抛未捕获异常**"，
     * 那会**把整个应用拖死**（现象是"点了重新连接，窗口直接没了"）。
     * 一个连接器坏掉不该让用户丢掉整个工作台，所以这里全部吞掉、只记诊断。
     */
    this.child.stdin.on("error", () => {
      /* 服务端已经死了：写失败是**预期内**的，不记也不抛 */
    });
    this.child.stdout.on("error", () => {});
    this.child.stderr.on("error", () => {});
    this.child.on("error", (e) => {
      this.state = "error";
      this.lastError = `进程错误：${e.message}`;
      this.failAllPending(this.lastError);
    });
    this.child.on("close", (code) => {
      if (this.state !== "off") {
        this.state = "error";
        this.lastError = this.lastError || `进程退出了（退出码 ${code ?? "?"}）`;
      }
      /* 进程没了就把在等的请求全部叫醒：否则工具调用会一直挂到超时 */
      this.failAllPending(this.lastError || "连接已断开");
    });

    try {
      const init = await this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ding-harness", version: "0.1.0" },
        },
        this.timeouts.handshakeMs,
      );
      if (init.error) throw new Error(init.error.message ?? "initialize 失败");
      this.notify("notifications/initialized");
      const listed = await this.request("tools/list", {}, this.timeouts.handshakeMs);
      if (listed.error) throw new Error(listed.error.message ?? "tools/list 失败");
      const raw = (listed.result ?? {}) as { tools?: unknown };
      const parsed: McpToolInfo[] = [];
      if (Array.isArray(raw.tools)) {
        for (const t of raw.tools) {
          const o = (t ?? {}) as Record<string, unknown>;
          if (typeof o.name !== "string" || !o.name) continue;
          parsed.push({
            name: o.name,
            ...(typeof o.description === "string" ? { description: o.description } : {}),
            ...(o.inputSchema === undefined ? {} : { inputSchema: o.inputSchema }),
          });
        }
      }
      this.tools = parsed;
      this.state = "on";
      return true;
    } catch (e) {
      this.state = "error";
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /**
   * 调一个工具。
   *
   * @param tool 服务端那边的工具名（**不带**本机前缀）
   * @param args 参数
   * @returns 文本结果，或者一句能照着改的错误
   */
  async call(tool: string, args: unknown): Promise<McpCallResult> {
    if (this.state !== "on") return { ok: false, error: `连接不可用（${this.errorText() || "没连上"}）` };
    try {
      const res = await this.request("tools/call", { name: tool, arguments: args ?? {} }, this.timeouts.callMs);
      if (res.error) return { ok: false, error: `服务端报错：${res.error.message ?? "未说明"}` };
      const result = (res.result ?? {}) as { content?: unknown; isError?: unknown };
      const text = contentToText(result.content);
      return { ok: true, text: text || "（这个工具没有返回文本）", isError: result.isError === true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 关掉（应用退出、或用户点了"重新连接"）。 */
  stop(): void {
    this.state = "off";
    this.failAllPending("已断开");
    try {
      /* 先把 stdin 正常收尾（很多 server 靠它退出），再杀 —— 顺序反了会留下半死的管道 */
      this.child?.stdin.end();
    } catch {
      /* 已经关了就算了 */
    }
    try {
      this.child?.kill();
    } catch {
      /* 已经没了就算了 */
    }
    this.child = null;
  }

  /* ── 内部：读一行一条 JSON ── */

  private onData(chunk: string): void {
    this.buffer += chunk;
    let at = this.buffer.indexOf("\n");
    while (at !== -1) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.onMessage(line);
      at = this.buffer.indexOf("\n");
    }
  }

  private onMessage(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      /* 不是 JSON 的行（服务端往 stdout 打了日志）——**忽略但不静默**：
         留着当诊断，因为它常常就是"连不上"的真因（很多 server 把日志打到了 stdout）。 */
      this.stderrTail = (this.stderrTail + `[stdout 非 JSON] ${line}\n`).slice(-STDERR_KEEP);
      return;
    }
    if (msg.id === undefined) return; // 通知：我们不需要处理
    const waiting = this.pending.get(Number(msg.id));
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(Number(msg.id));
    waiting.resolve(msg);
  }

  private failAllPending(reason: string): void {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      waiting.resolve({ id, error: { message: reason } });
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<RpcMessage> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<RpcMessage>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, error: { message: `超时（${timeoutMs} ms 没有回应）：${method}` } });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        this.child?.stdin.write(payload);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ id, error: { message: `写不进去：${e instanceof Error ? e.message : String(e)}` } });
      }
    });
  }

  private notify(method: string): void {
    try {
      this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    } catch {
      /* 通知发不出去不影响主流程 */
    }
  }
}

/**
 * 拼一行能交给 shell 执行的命令（含空格的部分加引号）。
 *
 * Windows 走 cmd 的规矩（用双引号，内部双引号翻倍）；其它平台走 sh 的规矩
 * （单引号，内部单引号用 `'\''` 断开）。
 *
 * @param command 可执行文件
 * @param args 参数
 * @returns 一个整行命令
 */
export function commandLine(command: string, args: readonly string[]): string {
  const win = process.platform === "win32";
  const quote = (part: string): string => {
    if (!part) return win ? '""' : "''";
    if (win) {
      return /[\s"&|<>^()]/.test(part) ? `"${part.replace(/"/g, '""')}"` : part;
    }
    return /[\s"'$`\&|<>()*?;[\]]/.test(part) ? `'${part.replace(/'/g, `'\''`)}'` : part;
  };
  return [command, ...args].map(quote).join(" ");
}

/**
 * 把 MCP 的 `content` 数组压成一段文本。
 *
 * 规范里 content 是数组（text / image / resource 各种）。我们**只取文本**，
 * 遇到非文本的**如实说明类型**（别假装没有这一段 —— 那会让模型以为工具什么都没返回）。
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
    else if (typeof o.type === "string") parts.push(`（${o.type} 类型的内容，本机版只取文本）`);
  }
  return parts.join("\n").trim();
}
