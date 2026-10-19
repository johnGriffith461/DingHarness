/**
 * LSP 诊断（G6）的**纯逻辑**。
 *
 * 这一层不碰进程：帧解析、配置收窄、按扩展名选服务器、诊断差异都在这里，
 * 所以 `Content-Length` 半包/粘包能在 vitest 里直接测。起进程与 JSON-RPC 收发
 * 在宿主（`electron/ipc/lsp.ts`）—— 与 MCP 同一条分层。
 *
 * ## 为什么不用 MCP 的"一行一条 JSON"
 *
 * LSP 的线上格式是 `Content-Length: N\r\n\r\n<body>`。把它当 NDJSON 读会一个
 * 字节都解不出来 —— 这是两种协议，不能复用同一个解析器。
 */

export type LspServerConfig = {
  /** LSP 的 languageId，例如 `typescript` / `python`。 */
  languageId: string;
  /** 可执行文件（`npx`、`typescript-language-server` …）。 */
  command: string;
  args?: string[];
  /** 只在这些文件扩展名上启用（不给时按 `languageId` 的默认表）。 */
  extensions?: string[];
  /** 启动前确认根目录里有这些文件（可选；不满足则跳过）。 */
  rootPatterns?: string[];
};

export type LspConfig = {
  /** `false` = 整体关闭（回滚开关）。 */
  enabled?: boolean;
  servers: LspServerConfig[];
};

/** languageId → 默认扩展名。只列**确实认识**的；不认识的显式配 `extensions`。 */
export const LSP_DEFAULT_EXTENSIONS: Record<string, string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  typescriptreact: [".tsx"],
  javascriptreact: [".jsx"],
  python: [".py"],
  rust: [".rs"],
  go: [".go"],
  java: [".java"],
  csharp: [".cs"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh"],
  c: [".c", ".h"],
  json: [".json"],
  yaml: [".yml", ".yaml"],
  css: [".css"],
  html: [".html", ".htm"],
};

export const LSP_MAX_SERVERS = 8;

/** 配置按不可信数据收窄：坏条目逐条丢掉，不把整份配置判死。 */
export function normalizeLspConfig(raw: unknown): LspConfig {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(o.servers) ? o.servers : [];
  const servers: LspServerConfig[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const languageId = typeof s.languageId === "string" ? s.languageId.trim().slice(0, 40) : "";
    const command = typeof s.command === "string" ? s.command.trim().slice(0, 400) : "";
    if (!languageId || !command) continue;
    const args = Array.isArray(s.args) ? s.args.filter((x): x is string => typeof x === "string").slice(0, 40) : undefined;
    const extensions = Array.isArray(s.extensions)
      ? s.extensions
          .filter((x): x is string => typeof x === "string")
          .map((x) => (x.startsWith(".") ? x : `.${x}`).toLowerCase())
          .slice(0, 20)
      : undefined;
    const rootPatterns = Array.isArray(s.rootPatterns)
      ? s.rootPatterns.filter((x): x is string => typeof x === "string").slice(0, 20)
      : undefined;
    servers.push({
      languageId,
      command,
      ...(args?.length ? { args } : {}),
      ...(extensions?.length ? { extensions } : {}),
      ...(rootPatterns?.length ? { rootPatterns } : {}),
    });
    if (servers.length >= LSP_MAX_SERVERS) break;
  }
  return { servers, ...(o.enabled === false ? { enabled: false } : {}) };
}

/** 按文件扩展名找服务器（`config.enabled === false` 时不启用）。 */
export function serverForFile(config: LspConfig, file: string): LspServerConfig | null {
  if (config.enabled === false) return null;
  const lower = String(file ?? "").toLowerCase();
  for (const server of config.servers) {
    const exts = server.extensions?.length ? server.extensions : LSP_DEFAULT_EXTENSIONS[server.languageId] ?? [];
    if (exts.some((ext) => lower.endsWith(ext.toLowerCase()))) return server;
  }
  return null;
}

/** 一条 LSP 帧：`Content-Length: N\r\n\r\n{json}`。 */
export function encodeLspMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/**
 * `Content-Length` 帧解析器（处理半包与粘包）。
 *
 * 用法：`parser.push(chunk)` 返回**本次能解出的完整消息**（可能 0 条或多条）；
 * 不完整的头部/正文留在内部缓冲，等下一块数据。
 */
export class LspFrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer | string): unknown[] {
    const next = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next]) : next;
    const out: unknown[] = [];
    for (;;) {
      const headerEnd = this.findHeaderEnd();
      if (!headerEnd) break;
      const headerText = this.buffer.subarray(0, headerEnd.index).toString("ascii");
      const match = /content-length\s*:\s*(\d+)/i.exec(headerText);
      if (!match) {
        /* 没长度头 = 这个帧没法切：丢掉头部，后面的字节继续找下一帧 */
        this.buffer = this.buffer.subarray(headerEnd.next);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd.next;
      if (this.buffer.length < bodyStart + length) break; // 等正文
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        out.push(JSON.parse(body) as unknown);
      } catch {
        /* 坏帧跳过它自己，不把后续帧一起丢掉 */
      }
    }
    return out;
  }

  /** 还有没有没解完的字节（诊断用）。 */
  pendingBytes(): number {
    return this.buffer.length;
  }

  private findHeaderEnd(): { index: number; next: number } | null {
    const crlf = this.buffer.indexOf("\r\n\r\n");
    const lf = this.buffer.indexOf("\n\n");
    if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, next: crlf + 4 };
    if (lf >= 0) return { index: lf, next: lf + 2 };
    return null;
  }
}

export type LspDiagnostic = {
  uri: string;
  /** LSP severity：1=Error，2=Warning，3=Info，4=Hint。 */
  severity?: number;
  code?: string | number;
  message: string;
  /** 1 基行号（给人看；LSP 本身是 0 基）。 */
  line?: number;
  character?: number;
};

/** `textDocument/publishDiagnostics` 的参数 → 只留 error。 */
export function diagnosticsFromPublish(params: unknown): LspDiagnostic[] {
  const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const uri = typeof p.uri === "string" ? p.uri : "";
  if (!uri || !Array.isArray(p.diagnostics)) return [];
  const out: LspDiagnostic[] = [];
  for (const item of p.diagnostics) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;
    const message = typeof d.message === "string" ? d.message : "";
    if (!message) continue;
    const severity = typeof d.severity === "number" ? d.severity : undefined;
    /* 只报 error（plan 明确：warning 不报）。severity 缺省按 LSP 规范当 error。 */
    if (severity !== undefined && severity !== 1) continue;
    const range = d.range && typeof d.range === "object" ? (d.range as Record<string, unknown>) : {};
    const start = range.start && typeof range.start === "object" ? (range.start as Record<string, unknown>) : {};
    const line = typeof start.line === "number" ? Math.max(0, Math.floor(start.line)) + 1 : undefined;
    const character = typeof start.character === "number" ? Math.floor(start.character) : undefined;
    const code =
      typeof d.code === "string" || typeof d.code === "number" ? (d.code as string | number) : undefined;
    out.push({
      uri,
      ...(severity === undefined ? {} : { severity }),
      ...(code === undefined ? {} : { code }),
      message,
      ...(line === undefined ? {} : { line }),
      ...(character === undefined ? {} : { character }),
    });
  }
  return out;
}

/** 诊断差异：只留 `after` 里**新出现**的 error。 */
export function newDiagnostics(before: LspDiagnostic[], after: LspDiagnostic[]): LspDiagnostic[] {
  const key = (d: LspDiagnostic) =>
    `${d.uri}|${String(d.code ?? "")}|${d.line ?? ""}|${d.character ?? ""}|${d.message}`;
  const seen = new Set(before.map(key));
  const out: LspDiagnostic[] = [];
  for (const d of after) {
    const k = key(d);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

/** 给模型/用户看的一句话（最多列 5 条，避免把工具结果撑爆）。 */
export function summarizeLspDiagnostics(errors: LspDiagnostic[], max = 5): string {
  if (!errors.length) return "LSP：无新诊断";
  const shown = errors.slice(0, max).map((d) => {
    const file = d.uri.split("/").pop() ?? d.uri;
    return `${file}${d.line ? `:${d.line}` : ""} ${d.message}`;
  });
  const rest = errors.length > shown.length ? `；另有 ${errors.length - shown.length} 条` : "";
  return `LSP：新引入 ${errors.length} 个错误 —— ${shown.join("；")}${rest}`;
}
