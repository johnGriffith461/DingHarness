import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  LspFrameParser,
  diagnosticsFromPublish,
  encodeLspMessage,
  newDiagnostics,
  serverForFile,
  summarizeLspDiagnostics,
  type LspConfig,
  type LspDiagnostic,
  type LspServerConfig,
} from "./lsp";

/**
 * LSP **进程客户端**（G6）。
 *
 * 放在 engine/runtime 而不是 electron：它不读全局路径、不 import electron，
 * 只吃 `(config, root, file)` 这几个参数 —— 所以能用**真的假 LSP server**
 * 在 vitest 里跑端到端。宿主（`electron/ipc/lsp.ts`）只负责读 `lsp.json` 与 IPC。
 *
 * 边界：
 * - 失败不阻塞编辑（启动失败/超时/崩溃都只意味着"这次没有诊断"）；
 * - 只报**新引入**的 error（warning 不报）；
 * - 每个 (server, root) 允许重启一次，再失败本会话禁用，避免每次编辑都等超时。
 */

type PublishWaiter = { uri: string; afterSeq: number; resolve: (ok: boolean) => void; timer: NodeJS.Timeout };

export class RunningLsp {
  private child: ChildProcessWithoutNullStreams;
  private parser = new LspFrameParser();
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private uriSeq = new Map<string, number>();
  private waiters: PublishWaiter[] = [];
  private docs = new Map<string, number>();
  private stderrTail = "";
  state: "starting" | "on" | "error" = "starting";
  lastError = "";

  constructor(
    private readonly server: LspServerConfig,
    private readonly root: string,
  ) {
    this.child = spawn(server.command, server.args ?? [], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      /* Windows 上 `typescript-language-server.cmd` 这类命令需要 shell 才能起 */
      shell: process.platform === "win32",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    /*
     * ⚠️ Linux/macOS 上 spawn 找不到命令时**不会触发 exit**，而是发 `error` 事件；
     * 没有监听器就是 unhandled exception —— 实测在 CI 的 gates-linux 上把整轮测试打红
     * （Windows 上走 shell 时表现为退出码 1，所以本机没暴露）。
     */
    this.child.on("error", (error) => {
      this.state = "error";
      this.lastError = `语言服务器启动失败：${error.message}`;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(this.lastError));
      }
      this.pending.clear();
    });
    this.child.on("exit", (code) => {
      this.state = "error";
      this.lastError = `语言服务器退出了（code ${code ?? "?"}）${this.stderrTail ? `：${this.stderrTail.trim().split("\n").slice(-2).join("；")}` : ""}`;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(this.lastError));
      }
      this.pending.clear();
    });
  }

  async start(timeoutMs = 8000): Promise<boolean> {
    try {
      await this.request(
        "initialize",
        {
          processId: process.pid,
          rootUri: pathToFileURL(this.root).toString(),
          capabilities: {
            textDocument: { publishDiagnostics: { relatedInformation: false }, synchronization: { didSave: false } },
          },
          clientInfo: { name: "ding-harness", version: "0.6.0" },
        },
        timeoutMs,
      );
      this.notify("initialized", {});
      this.state = "on";
      return true;
    } catch (error) {
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /**
   * 让服务器看一份文本并等它的 publishDiagnostics。
   *
   * @returns 超时/失败返回 `null`（调用方按"没有诊断"处理）
   */
  async diagnosticsFor(file: string, text: string, timeoutMs = 3000): Promise<LspDiagnostic[] | null> {
    if (this.state !== "on") return null;
    const uri = pathToFileURL(path.resolve(file)).toString();
    const before = this.uriSeq.get(uri) ?? 0;
    const version = (this.docs.get(uri) ?? 0) + 1;
    this.docs.set(uri, version);
    if (version === 1) {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: this.server.languageId, version, text },
      });
    } else {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    const got = await this.waitForPublish(uri, before, timeoutMs);
    return got ? this.diagnostics.get(uri) ?? [] : null;
  }

  stop(): void {
    try {
      this.child.kill();
    } catch {
      /* 已退 */
    }
  }

  private waitForPublish(uri: string, afterSeq: number, timeoutMs: number): Promise<boolean> {
    if ((this.uriSeq.get(uri) ?? 0) > afterSeq) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        resolve(false);
      }, timeoutMs);
      this.waiters.push({ uri, afterSeq, resolve: done, timer });
    });
  }

  private onData(chunk: Buffer): void {
    for (const message of this.parser.push(chunk)) this.onMessage(message);
  }

  private onMessage(raw: unknown): void {
    const msg = raw as { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(typeof msg.error === "object" ? JSON.stringify(msg.error) : String(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const items = diagnosticsFromPublish(msg.params);
      const uri = (msg.params as { uri?: string } | undefined)?.uri ?? "";
      if (!uri) return;
      const seq = (this.uriSeq.get(uri) ?? 0) + 1;
      this.uriSeq.set(uri, seq);
      this.diagnostics.set(uri, items);
      const ready = this.waiters.filter((w) => w.uri === uri && seq > w.afterSeq);
      this.waiters = this.waiters.filter((w) => !ready.includes(w));
      for (const w of ready) w.resolve(true);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs} ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encodeLspMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.child.stdin.write(encodeLspMessage({ jsonrpc: "2.0", method, params }));
    } catch {
      /* 子进程已退出：下一次请求会报错 */
    }
  }
}

const running = new Map<string, RunningLsp>();
/** 每个 (server, root) 允许重启一次；再失败就本会话禁用（避免每次编辑都等超时）。 */
const startAttempts = new Map<string, number>();

/** 根目录探测：从文件所在目录往上找 rootPatterns（找不到就用文件目录）。 */
async function projectRootFor(file: string, server: LspServerConfig): Promise<string> {
  const patterns = server.rootPatterns ?? defaultRootPatterns(server.languageId);
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 12; i += 1) {
    for (const pattern of patterns) {
      try {
        await fs.access(path.join(dir, pattern));
        return dir;
      } catch {
        /* 继续往上 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.resolve(file));
}

function defaultRootPatterns(languageId: string): string[] {
  switch (languageId) {
    case "typescript":
    case "javascript":
    case "typescriptreact":
    case "javascriptreact":
      return ["tsconfig.json", "jsconfig.json", "package.json"];
    case "python":
      return ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"];
    case "rust":
      return ["Cargo.toml"];
    case "go":
      return ["go.mod"];
    case "java":
      return ["pom.xml", "build.gradle", "build.gradle.kts"];
    default:
      return [];
  }
}

/** 按 (server, root) 复用连接；崩溃后重启一次，再失败返回 null。 */
async function ensureRunning(server: LspServerConfig, root: string): Promise<RunningLsp | null> {
  const key = `${server.languageId}::${server.command}::${root}`;
  const hit = running.get(key);
  if (hit?.state === "on") return hit;
  if (hit) {
    if ((startAttempts.get(key) ?? 0) >= 2) return null;
    running.delete(key);
  }
  startAttempts.set(key, (startAttempts.get(key) ?? 0) + 1);
  const instance = new RunningLsp(server, root);
  running.set(key, instance);
  const ok = await instance.start();
  if (!ok) {
    console.error(`[lsp] ${server.languageId} 启动失败：${instance.lastError}`);
    return null;
  }
  return instance;
}

export type LspEditResult = {
  /** 给用户/模型看的一句话（没有配置时为空串）。 */
  line: string;
  /** 新引入的 error（结构化，便于测试与后续 UI）。 */
  errors: LspDiagnostic[];
};

/**
 * 编辑后的诊断（只报新增 error）。
 *
 * @param config 已收窄的 LSP 配置
 * @param edits 每个文件：绝对路径 + **编辑前**的文本（新建文件传 null）
 */
export async function lspNoteForEdits(
  config: LspConfig,
  edits: Array<{ path: string; before: string | null }>,
): Promise<LspEditResult> {
  if (config.enabled === false || !config.servers.length) return { line: "", errors: [] };
  const allNew: LspDiagnostic[] = [];
  let attempted = 0;
  let checked = 0;
  for (const edit of edits) {
    const server = serverForFile(config, edit.path);
    if (!server) continue;
    attempted += 1;
    const root = await projectRootFor(edit.path, server);
    const instance = await ensureRunning(server, root);
    if (!instance) continue;
    checked += 1;
    let afterText: string;
    try {
      afterText = await fs.readFile(edit.path, "utf8");
    } catch {
      continue; // 文件被删/读不了：没有可诊断的内容
    }
    const beforeItems = edit.before === null ? [] : (await instance.diagnosticsFor(edit.path, edit.before)) ?? [];
    const afterItems = (await instance.diagnosticsFor(edit.path, afterText)) ?? [];
    allNew.push(...newDiagnostics(beforeItems, afterItems));
  }
  /*
   * 说清"没检查"与"检查了没新错误"的区别：服务器没起来时不能报"无新诊断"，
   * 那是把"没看"说成"没问题"。
   */
  const line = !checked
    ? attempted
      ? "LSP：语言服务器没起来，本次未诊断（设置 → 通用 → LSP 诊断可看原因）"
      : ""
    : summarizeLspDiagnostics(allNew);
  return { line, errors: allNew };
}

/** 配置里每个服务器的当前状态（设置页用）。 */
export function lspStatusOf(config: LspConfig): Array<{
  languageId: string;
  command: string;
  args: string[];
  status: "stopped" | "starting" | "on" | "error";
  error: string;
}> {
  return config.servers.map((server) => {
    const instance = [...running.entries()].find(([key]) =>
      key.startsWith(`${server.languageId}::${server.command}::`),
    )?.[1];
    return {
      languageId: server.languageId,
      command: server.command,
      args: server.args ?? [],
      status: instance ? instance.state : "stopped",
      error: instance?.state === "error" ? instance.lastError : "",
    };
  });
}

export function stopAllLsp(): void {
  for (const instance of running.values()) instance.stop();
  running.clear();
  startAttempts.clear();
}
