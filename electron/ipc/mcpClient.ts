import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { McpServerConfig } from "../../shared/mcp";
import { wrapExternalContent } from "../../shared/untrusted";
import { parseWwwAuthenticate } from "./mcpOAuth";

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

/**
 * **一条连接**（U04，2026-10-18）：stdio 与 HTTP 两种传输共用的形状。
 *
 * `mcpStore` 只认这个接口 —— 加第三种传输时是"再写一个实现"，
 * 不是"在 store 里加一串 if"。
 */
export type McpResourceInfo = {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
};

export type McpPromptInfo = {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

export type McpResourceContent = { uri: string; mimeType?: string; text: string };

export type McpConnection = {
  status(): McpStatus;
  errorText(): string;
  toolList(): McpToolInfo[];
  start(): Promise<boolean>;
  call(tool: string, args: unknown): Promise<McpCallResult>;
  stop(): void;
  /* F1：resources/prompts 是**可选**能力（服务端没声明就不实现） */
  listResources?(): Promise<McpResourceInfo[]>;
  readResource?(uri: string): Promise<McpResourceContent[]>;
  listPrompts?(): Promise<McpPromptInfo[]>;
  getPrompt?(name: string, args?: Record<string, string>): Promise<Array<{ role: string; text: string }>>;
  /**
   * G4：最近一次 401 的 `WWW-Authenticate`（授权按钮发现元数据用）。
   * 只对 HTTP 传输有意义；没遇到 401 时返回 undefined。
   */
  authHint?(): { resourceMetadata?: string; scope?: string } | undefined;
};

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
export class McpClient implements McpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (m: RpcMessage) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private stderrTail = "";
  private tools: McpToolInfo[] = [];
  private state: McpStatus = "off";
  private lastError = "";
  /** 服务端说工具清单变了，正在重列（避免并发触发多次） */
  private refreshing = false;

  constructor(
    private readonly config: McpServerConfig,
    /* 可注入：单测要验“服务端不答会超时”，用真实值得等 15 秒 —— 那换不来任何东西 */
    private readonly timeouts: McpTimeouts = DEFAULT_TIMEOUTS,
    /**
     * U04 的两个可选能力：
     * - `attachmentsDir`：非文本内容（图片/二进制资源）落到这个目录，回注路径；
     * - `onToolsChanged`：服务端发 `tools/list_changed` 时被叫一次（宿主可据此刷新界面）。
     */
    private readonly opts: {
      attachmentsDir?: string;
      onToolsChanged?: (tools: McpToolInfo[]) => void;
    } = {},
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
      this.child = spawn(commandLine(this.config.command ?? "", this.config.args ?? []), {
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
          /* F1：声明 resources/prompts 能力，服务端才会在 list 里给出它们 */
          capabilities: { resources: {}, prompts: {} },
          clientInfo: { name: "ding-harness", version: "0.3.0" },
        },
        this.timeouts.handshakeMs,
      );
      if (init.error) throw new Error(init.error.message ?? "initialize 失败");
      this.notify("notifications/initialized");
      const listed = await this.listTools();
      if (!listed) throw new Error(this.lastError || "tools/list 失败");
      this.state = "on";
      return true;
    } catch (e) {
      this.state = "error";
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /**
   * 重新列工具（U04：服务端发 `notifications/tools/list_changed` 之后调）。
   *
   * @returns 列成功了没有（失败只记状态，不抛 —— 它是后台通知触发的）
   */
  async refreshTools(): Promise<boolean> {
    if (this.refreshing || this.state !== "on") return false;
    this.refreshing = true;
    try {
      const ok = await this.listTools();
      if (ok) this.opts.onToolsChanged?.(this.toolList());
      return ok;
    } finally {
      this.refreshing = false;
    }
  }

  /** 发一次 `tools/list` 并替换内存里的清单。 */
  private async listTools(): Promise<boolean> {
    const listed = await this.request("tools/list", {}, this.timeouts.handshakeMs);
    if (listed.error) {
      this.lastError = listed.error.message ?? "tools/list 失败";
      return false;
    }
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
    return true;
  }

  /** F1：列资源（服务端不声明就返回空数组，不报错）。 */
  async listResources(): Promise<McpResourceInfo[]> {
    if (this.state !== "on") return [];
    const listed = await this.request("resources/list", {}, this.timeouts.handshakeMs);
    if (listed.error) return [];
    const raw = (listed.result ?? {}) as { resources?: unknown };
    if (!Array.isArray(raw.resources)) return [];
    return raw.resources.flatMap((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      if (typeof o.uri !== "string" || !o.uri) return [];
      return [
        {
          uri: o.uri,
          name: typeof o.name === "string" && o.name ? o.name : o.uri,
          ...(typeof o.mimeType === "string" ? { mimeType: o.mimeType } : {}),
          ...(typeof o.description === "string" ? { description: o.description } : {}),
        },
      ];
    });
  }

  /** F1：读一个资源（文本内容原样返回；二进制内容给出 uri 与 mime）。 */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    if (this.state !== "on") return [];
    const res = await this.request("resources/read", { uri }, this.timeouts.callMs);
    if (res.error) return [];
    const raw = (res.result ?? {}) as { contents?: unknown };
    if (!Array.isArray(raw.contents)) return [];
    return raw.contents.flatMap((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      if (typeof o.text === "string") {
        return [{ uri: typeof o.uri === "string" ? o.uri : uri, ...(typeof o.mimeType === "string" ? { mimeType: o.mimeType } : {}), text: o.text }];
      }
      return [{ uri: typeof o.uri === "string" ? o.uri : uri, text: "（这个资源不是文本内容）" }];
    });
  }

  /** F1：列提示词。 */
  async listPrompts(): Promise<McpPromptInfo[]> {
    if (this.state !== "on") return [];
    const listed = await this.request("prompts/list", {}, this.timeouts.handshakeMs);
    if (listed.error) return [];
    const raw = (listed.result ?? {}) as { prompts?: unknown };
    if (!Array.isArray(raw.prompts)) return [];
    return raw.prompts.flatMap((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      if (typeof o.name !== "string" || !o.name) return [];
      const args = Array.isArray(o.arguments)
        ? o.arguments.flatMap((a) => {
            const arg = (a ?? {}) as Record<string, unknown>;
            if (typeof arg.name !== "string") return [];
            return [
              {
                name: arg.name,
                ...(typeof arg.description === "string" ? { description: arg.description } : {}),
                ...(arg.required === true ? { required: true } : {}),
              },
            ];
          })
        : [];
      return [
        {
          name: o.name,
          ...(typeof o.description === "string" ? { description: o.description } : {}),
          ...(args.length ? { arguments: args } : {}),
        },
      ];
    });
  }

  /** F1：取一个提示词的内容（转成 role + text 的普通消息）。 */
  async getPrompt(name: string, args?: Record<string, string>): Promise<Array<{ role: string; text: string }>> {
    if (this.state !== "on") return [];
    const res = await this.request("prompts/get", { name, arguments: args ?? {} }, this.timeouts.callMs);
    if (res.error) return [];
    const raw = (res.result ?? {}) as { messages?: unknown };
    if (!Array.isArray(raw.messages)) return [];
    return raw.messages.flatMap((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const content = (o.content ?? {}) as Record<string, unknown>;
      if (typeof content.text !== "string") return [];
      return [{ role: typeof o.role === "string" ? o.role : "user", text: content.text }];
    });
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
      const text = contentToText(result.content, (mime, data, kind) => this.saveAttachment(mime, data, kind));
      /*
       * G19：连接器返回的是**外部内容**，进上下文前标注来源并做注入提示。
       * 它仍然是工具结果（不拒绝、不改写），只是不让模型把它当成用户指令。
       */
      return {
        ok: true,
        text: wrapExternalContent("mcp", text || "（这个工具没有返回文本）"),
        isError: result.isError === true,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 非文本内容落盘（U04）：图片 / 二进制资源写进 `attachmentsDir`，回注路径。
   *
   * 为什么是落盘而不是把 base64 塞进正文：几兆的 base64 会直接吃爆上下文，
   * 而模型本来也"看不出像素"。落成文件之后，用户能打开、模型能再读（若它是文本），
   * 这是"不丢内容"里最诚实的一档。
   *
   * @returns 落点路径；没有目录或写失败时给空串（调用方改成"类型 + 大小"的文字说明）
   */
  private saveAttachment(mime: string, base64: string, kind: string): string {
    const dir = this.opts.attachmentsDir;
    if (!dir || !base64) return "";
    try {
      fs.mkdirSync(dir, { recursive: true });
      const ext = extensionFor(mime, kind);
      const file = path.join(dir, `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      fs.writeFileSync(file, Buffer.from(base64, "base64"));
      return file;
    } catch {
      return "";
    }
  }

  /**
   * 关掉（应用退出、或用户点了"重新连接"）。
   *
   * ⭐ **杀整棵树，不只杀壳**（2026-10-16，审计 P41）。
   *
   * 这个子进程是用 `shell: true` 起的：Windows 上真正的进程是 `cmd.exe`，
   * 它下面才是 `node <server>`。`child.kill()` **只杀 cmd.exe** ——
   * 连接器进程留下来继续跑（还占着那个管道），而界面显示"已断开"。
   * `execTool.ts` 里早就有现成的办法（`taskkill /F /T /PID`，注释里专门写了这件事），
   * 这里一直没接上。
   */
  stop(): void {
    this.state = "off";
    this.failAllPending("已断开");
    const child = this.child;
    try {
      /* 先把 stdin 正常收尾（很多 server 靠它退出），再杀 —— 顺序反了会留下半死的管道 */
      child?.stdin.end();
    } catch {
      /* 已经关了就算了 */
    }
    if (child?.pid && process.platform === "win32") {
      /*
       * `/T` 连同子进程一起杀（`shell:true` 之下 cmd.exe 只是外壳）。
       * 同步：`stop()` 的契约是"回来时已经收完尸"（退出路径上直接调它）。
       */
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } else {
      try {
        child?.kill();
      } catch {
        /* 已经没了就算了 */
      }
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
    if (msg.id === undefined) {
      /*
       * 通知（U04）：`tools/list_changed` 要**真的重列** —— 原来这里直接 return，
       * 于是服务端换了工具清单，模型那边一直拿着旧的（新工具永远看不到，
       * 删掉的工具调到超时）。
       */
      if (msg.method === "notifications/tools/list_changed") void this.refreshTools();
      /* F1：资源/提示词清单变了不需要缓存刷新（每次都现查），这里只留着口子 */
      if (msg.method === "notifications/resources/list_changed") void this.refreshTools();
      if (msg.method === "notifications/prompts/list_changed") void this.refreshTools();
      return;
    }
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
 * 规范里 content 是数组（text / image / resource / audio 各种）。U04 之后：
 * - `text`：原样；
 * - `image` / `audio`：**落盘**（给了 `save` 的话）并回注路径；落不了就如实说类型与字节数；
 * - `resource`：文本资源给正文，二进制资源同 image 那条路。
 *
 * ⚠️ 仍然**不**把整段 base64 塞进正文 —— 那会直接吃爆上下文。
 */
function contentToText(
  content: unknown,
  save?: (mime: string, base64: string, kind: string) => string,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") {
      parts.push(o.text);
      continue;
    }
    if ((o.type === "image" || o.type === "audio") && typeof o.data === "string") {
      const mime = typeof o.mimeType === "string" ? o.mimeType : "application/octet-stream";
      const bytes = Math.round((o.data.length * 3) / 4);
      const saved = save?.(mime, o.data, o.type) ?? "";
      parts.push(
        saved
          ? `（${o.type} 内容：${mime}，${bytes} 字节，已保存到 ${saved}）`
          : `（${o.type} 内容：${mime}，${bytes} 字节 —— 没有配置落盘目录，像素/音频没有进上下文）`,
      );
      continue;
    }
    if (o.type === "resource") {
      const resource = (o.resource ?? {}) as Record<string, unknown>;
      if (typeof resource.text === "string") {
        parts.push(resource.text);
      } else if (typeof resource.blob === "string") {
        const mime = typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
        const saved = save?.(mime, resource.blob, "resource") ?? "";
        const uri = typeof resource.uri === "string" ? resource.uri : "";
        parts.push(
          saved ? `（资源 ${uri || mime} 已保存到 ${saved}）` : `（资源 ${uri || mime}，二进制内容没有进上下文）`,
        );
      } else {
        parts.push(`（resource 内容，未识别字段）`);
      }
      continue;
    }
    if (typeof o.type === "string") parts.push(`（${o.type} 类型的内容，本机版暂不展示）`);
  }
  return parts.join("\n").trim();
}

/** MIME → 文件扩展名（只覆盖 MCP 常见的几种；其余走 bin）。 */
function extensionFor(mime: string, kind: string): string {
  const table: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "text/plain": "txt",
    "application/json": "json",
  };
  return table[mime.split(";")[0]!.trim().toLowerCase()] ?? (kind === "audio" ? "audio" : "bin");
}

/**
 * **streamable HTTP 传输**（U04，2026-10-18）。
 *
 * 规范（2025-03-26 的 Streamable HTTP）要点：
 * - 所有消息都是 **POST** 到同一个端点；
 * - 请求头带 `Accept: application/json, text/event-stream`；
 * - 回包可能是 `application/json`（一条），也可能是 `text/event-stream`（若干条，
 *   用 `\n\n` 分帧、`data:` 行里是 JSON）；
 * - 服务端在 initialize 的回包头里给 `Mcp-Session-Id`，之后每个请求都要带上；
 * - 会话过期通常表现为 **404** —— 这时要**重新握手一次**，而不是把错误直接抛给模型。
 *
 * ⚠️ 如实记边界：这里**不复用** stdio 那套 id 匹配（HTTP 是一次请求一次回包），
 * 但两者对外是同一个 `McpConnection` 形状。
 */
export class HttpMcpClient implements McpConnection {
  private tools: McpToolInfo[] = [];
  private state: McpStatus = "off";
  private lastError = "";
  private sessionId = "";
  private nextId = 1;
  /** G4：最近一次 401 的鉴权头（授权按钮据此发现资源元数据）。 */
  private wwwAuthenticate = "";

  constructor(
    private readonly config: McpServerConfig,
    private readonly timeouts: McpTimeouts = DEFAULT_TIMEOUTS,
    private readonly opts: {
      attachmentsDir?: string;
      onToolsChanged?: (tools: McpToolInfo[]) => void;
      /** G4：取/刷新 OAuth access token；没配置 = 不做 OAuth。 */
      oauth?: { getToken: (forceRefresh?: boolean) => Promise<string | null> };
    } = {},
  ) {}

  status(): McpStatus {
    return this.state;
  }

  errorText(): string {
    return this.lastError;
  }

  toolList(): McpToolInfo[] {
    return [...this.tools];
  }

  authHint(): { resourceMetadata?: string; scope?: string } | undefined {
    if (!this.wwwAuthenticate) return undefined;
    const got = parseWwwAuthenticate(this.wwwAuthenticate);
    return Object.keys(got).length ? got : undefined;
  }

  async start(): Promise<boolean> {
    if (this.config.enabled === false || !this.config.url) {
      this.state = this.config.enabled === false ? "off" : "error";
      if (this.config.enabled !== false) this.lastError = "配置里没有 url";
      return false;
    }
    this.state = "starting";
    this.sessionId = "";
    const init = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ding-harness", version: "0.3.0" },
      },
    });
    if (!init.ok) {
      this.state = "error";
      this.lastError = init.error;
      return false;
    }
    /* 回包头里给会话 id（有的实现不给，那就无状态跑） */
    this.sessionId = init.sessionId;
    this.notify("notifications/initialized");
    const listed = await this.listTools();
    if (!listed) {
      this.state = "error";
      return false;
    }
    this.state = "on";
    return true;
  }

  /** 重新列工具（`tools/list_changed` 之后调）。 */
  async refreshTools(): Promise<boolean> {
    if (this.state !== "on") return false;
    const ok = await this.listTools();
    if (ok) this.opts.onToolsChanged?.(this.toolList());
    return ok;
  }

  async call(tool: string, args: unknown): Promise<McpCallResult> {
    if (this.state !== "on") return { ok: false, error: `连接不可用（${this.lastError || "没连上"}）` };
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name: tool, arguments: args ?? {} },
    });
    if (!res.ok) return { ok: false, error: res.error };
    /* 服务端在流里发过 list_changed：回包处理完再刷一次 */
    if (res.toolsChanged) void this.refreshTools();
    const reply = res.message;
    if (reply.error) return { ok: false, error: `服务端报错：${reply.error.message ?? "未说明"}` };
    const result = (reply.result ?? {}) as { content?: unknown; isError?: unknown };
    const text = contentToText(result.content, (mime, data, kind) => this.saveAttachment(mime, data, kind));
    /*
     * G19：连接器返回的是**外部内容**，进上下文前标注来源并做注入提示。
     * 它仍然是工具结果（不拒绝、不改写），只是不让模型把它当成用户指令。
     */
    return {
      ok: true,
      text: wrapExternalContent("mcp", text || "（这个工具没有返回文本）"),
      isError: result.isError === true,
    };
  }

  /** HTTP 没有子进程可收 —— 只清会话（下次 start 重新握手）。 */
  stop(): void {
    this.state = "off";
    this.sessionId = "";
  }

  /* ── 内部 ── */

  private async listTools(): Promise<boolean> {
    const res = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} });
    if (!res.ok) {
      this.lastError = res.error;
      return false;
    }
    const raw = (res.message.result ?? {}) as { tools?: unknown };
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
    return true;
  }

  private saveAttachment(mime: string, base64: string, kind: string): string {
    const dir = this.opts.attachmentsDir;
    if (!dir || !base64) return "";
    try {
      fs.mkdirSync(dir, { recursive: true });
      const ext = extensionFor(mime, kind);
      const file = path.join(dir, `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      fs.writeFileSync(file, Buffer.from(base64, "base64"));
      return file;
    } catch {
      return "";
    }
  }

  /** 发一条通知（服务端可能回 202/204，也可能什么都不回）。 */
  private notify(method: string): void {
    void this.post({ jsonrpc: "2.0", method }, { silent: true }).catch(() => undefined);
  }

  /**
   * POST 一条 JSON-RPC 消息并取出回包。
   *
   * @param body 消息
   * @param opts.silent 通知用：不关心回包（也不因回包失败改状态）
   */
  private async post(
    body: Record<string, unknown>,
    opts: { silent?: boolean; retriedAfterAuth?: boolean } = {},
  ): Promise<{ ok: true; message: RpcMessage; sessionId: string; toolsChanged: boolean } | { ok: false; error: string }> {
    const url = this.config.url!;
    /*
     * G4：有授权就把 token 注入 `Authorization`。显式配置的 headers 优先级更高 ——
     * 用户手写了 `Authorization` 就不该被 OAuth 静默覆盖。
     */
    const accessToken = this.opts.oauth ? await this.opts.oauth.getToken().catch(() => null) : null;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(this.config.headers ?? {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeouts.callMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 404 && this.sessionId) {
        /*
         * 会话过期（规范允许服务端这么表达）：**重新握手一次**再重试这一个请求。
         * 只重试一次 —— 无限重试会在服务端一直 404 时变成死循环。
         */
        this.sessionId = "";
        const re = await this.start();
        if (!re) return { ok: false, error: `会话过期且重新握手失败：${this.lastError}` };
        return this.post(body, opts);
      }
      if (res.status === 401) {
        /* 留住鉴权头：授权按钮要靠它发现 `resource_metadata`（OAuth 发现的第一跳）。 */
        this.wwwAuthenticate = res.headers.get("www-authenticate") ?? this.wwwAuthenticate;
        if (this.opts.oauth && !opts.retriedAfterAuth) {
          const refreshed = await this.opts.oauth.getToken(true).catch(() => null);
          if (refreshed && refreshed !== accessToken) {
            return this.post(body, { ...opts, retriedAfterAuth: true });
          }
          return {
            ok: false,
            error: "需要授权：在「插件·技能·伙伴 → 连接器」里点「授权」，完成后会自动重连",
          };
        }
        if (this.opts.oauth) {
          return { ok: false, error: "授权已过期：请重新授权" };
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ""}` };
      }
      const sessionId = res.headers.get("mcp-session-id") ?? this.sessionId;
      if (opts.silent) return { ok: true, message: {}, sessionId, toolsChanged: false };
      const type = res.headers.get("content-type") ?? "";
      const text = await res.text();
      const parsed = type.includes("text/event-stream") ? parseSse(text) : { messages: parseJsonMessages(text), toolsChanged: false };
      /*
       * 回包里可能不止一条（SSE）：找到与请求 id 对上的那条。
       * 找不到但只有一条时就用那一条（有的服务端把 id 原样换掉/省略）。
       */
      const wanted = typeof body.id === "number" ? body.id : undefined;
      const target =
        parsed.messages.find((m) => wanted !== undefined && Number(m.id) === wanted) ??
        (parsed.messages.length === 1 ? parsed.messages[0] : undefined);
      if (!target) return { ok: false, error: "回包里没有能对上号的 JSON-RPC 消息" };
      return { ok: true, message: target, sessionId, toolsChanged: parsed.toolsChanged };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message.includes("abort") ? `超时（${this.timeouts.callMs} ms）` : message };
    }
  }
}

/**
 * 一段文本 → 若干 JSON 消息（`application/json` 那条路；也容忍行分隔的多条）。
 *
 * @param text 回包正文
 */
function parseJsonMessages(text: string): RpcMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const one = JSON.parse(trimmed) as unknown;
    return Array.isArray(one) ? (one as RpcMessage[]) : [one as RpcMessage];
  } catch {
    const out: RpcMessage[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        out.push(JSON.parse(t) as RpcMessage);
      } catch {
        /* 坏行跳过（服务端日志混进 stdout 的情形） */
      }
    }
    return out;
  }
}

/**
 * SSE 文本 → 消息列表 + 有没有 `tools/list_changed` 通知。
 *
 * @param text 事件流正文
 */
function parseSse(text: string): { messages: RpcMessage[]; toolsChanged: boolean } {
  const messages: RpcMessage[] = [];
  let toolsChanged = false;
  const frames = text.split(/\r?\n\r?\n+/);
  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!data) continue;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(data) as RpcMessage;
    } catch {
      continue;
    }
    if (msg.method === "notifications/tools/list_changed") toolsChanged = true;
    if (msg.id !== undefined) messages.push(msg);
  }
  return { messages, toolsChanged };
}
