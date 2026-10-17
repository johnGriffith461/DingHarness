import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createCanvasStore, type CanvasStore } from "../../engine/adapters/sqliteCanvasStore";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  applyCanvasTool,
  CANVAS_ID,
  canvasDataDir,
  canvasDocPath,
  canvasTools,
  emptyCanvasDoc,
  type CanvasDoc,
} from "./canvasTools";

/**
 * **画布 MCP server 的协议那一半**（V5-4 任务 4.5）。
 *
 * 形态：**stdio + JSON-RPC 2.0**（一行一条消息）—— MCP 的标准传输之一。
 * 支持的往返：`initialize` / `ping` / `tools/list` / `tools/call`；
 * 通知（`notifications/*`）不回应（JSON-RPC 规矩：通知没有 id，也不需要结果）。
 *
 * ```
 * DH_DATA_DIR=~/.ding  npx tsx hosts/mcp/canvasServer.ts
 * ```
 *
 * 别名还有一个：`DSH_CANVAS_DATA_DIR`（与桌面同一个环境变量 —— 指到同一份数据）。
 *
 * ⚠️ **stdout 是协议通道**：往里写任何非 JSON 的东西都会让客户端解析失败。
 * 所有日志走 stderr（`log()` 就是为这件事存在的）。
 */

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "ding-canvas", version: "0.1.0" };

/** 日志（**一律 stderr** —— stdout 归协议）。 */
const log = (line: string): void => {
  process.stderr.write(`[canvas-mcp] ${line}\n`);
};

/** 读画布文档（不存在给默认文档 —— 不报错：第一次用就该能直接加节点）。 */
export function readDoc(file: string): CanvasDoc {
  if (!existsSync(file)) return emptyCanvasDoc();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CanvasDoc>;
    return { ...emptyCanvasDoc(), ...parsed, nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [] };
  } catch (error) {
    throw new Error(`画布文档读不动（${file}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 原子写（临时文件 + rename —— 与桌面 `snapshotStore` 同一个口径，别写半个文档）。 */
export function writeDoc(file: string, doc: CanvasDoc): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

/**
 * 处理一条 JSON-RPC 消息；返回要回的那一条（通知返回 null）。
 *
 * @param deps.docFile 画布文档（`document.json`）—— **派生缓存**，下面 `canvas` 才是真相
 * @param deps.canvas 画布事件库（V5 收尾）。不给 = 只写那份 JSON（老行为）——
 *   但那样"谁改的画布"就查不到，所以真实运行路径一定给（见文件尾的启动处）
 * @param deps.actor 谁在改（MCP 客户端）—— 进事件流的 `actor`（C5）
 */
export function handleMessage(
  raw: string,
  deps: { docFile: string; log?: (l: string) => void; canvas?: CanvasStore; actor?: { id: string; kind: "user" } },
): string | null {
  let msg: Rpc;
  try {
    msg = JSON.parse(raw) as Rpc;
  } catch {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "解析失败：这一行不是 JSON" } });
  }
  if (!msg || typeof msg.method !== "string") {
    return JSON.stringify({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "不是一条合法请求" } });
  }
  const id = msg.id;
  const ok = (result: unknown): string => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
  const fail = (code: number, message: string): string => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  /* 通知：没有 id，不回任何东西 */
  const isNotification = id === undefined;
  if (msg.method.startsWith("notifications/")) return null;

  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "这个 server 让外部 MCP 客户端驱动 Ding Harness 的画布（加节点等）。",
      });

    case "ping":
      return ok({});

    case "tools/list":
      return ok({ tools: canvasTools() });

    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!name) return fail(-32602, "缺 name（要调哪个工具）");
      try {
        const doc = readDoc(deps.docFile);
        const applied = applyCanvasTool({ doc, name, args });
        if ("error" in applied) {
          /* 工具层的拒绝是**结果**不是协议错（与内核"错误即结果"同一个口径） */
          return ok({ content: [{ type: "text", text: applied.error }], isError: true });
        }
        /*
         * ⭐ **事件进日志，文档是派生缓存**（V5 收尾；C6 3.9a）：
         * 外部客户端改了画布，这件事必须留痕（"谁在什么时候加了哪个节点"）——
         * 光写 document.json 的话，审计与合作那两侧都看不见。
         */
        if (deps.canvas) {
          const actor = deps.actor ?? { id: "mcp", kind: "user" as const };
          deps.canvas.save({ canvasId: CANVAS_ID, doc: applied.doc, owner: "local", actor });
        }
        writeDoc(deps.docFile, applied.doc);
        deps.log?.(`${name} → revision ${applied.doc.revision}（${applied.doc.nodes.length} 个节点）`);
        return ok(applied.result);
      } catch (error) {
        return ok({
          content: [{ type: "text", text: `画布文件出问题：${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return fail(-32601, `不认识的方法：${msg.method}（这一版支持 initialize / ping / tools/list / tools/call）`);
  }
}

/** 主循环：逐行读 stdin，把回应写 stdout。 */
export function startServer(deps: { docFile: string; canvas?: CanvasStore }): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  /*
   * 谁在改（C5）：握手时客户端会报名字 —— 记下来进事件的 `actor`
   * （`mcp:<名字>` 一眼能看出这不是本机用户改的）。没握手就用 `mcp`。
   */
  let clientName = "mcp";
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      /* 从 initialize 里记下客户端名字（解析失败就算了 —— 那一条由 handleMessage 去答） */
      try {
        const peek = JSON.parse(trimmed) as { method?: string; params?: { clientInfo?: { name?: unknown } } };
        const name = peek?.params?.clientInfo?.name;
        if (peek?.method === "initialize" && typeof name === "string" && name.trim()) clientName = `mcp:${name.trim().slice(0, 40)}`;
      } catch {
        /* 不是 JSON：交给 handleMessage 去回 -32700 */
      }
      const out = handleMessage(trimmed, {
        docFile: deps.docFile,
        log,
        ...(deps.canvas ? { canvas: deps.canvas } : {}),
        actor: { id: clientName, kind: "user" },
      });
      if (out !== null) process.stdout.write(`${out}\n`);
    });
    rl.on("close", () => resolve());
  });
}

/* 作为脚本直接跑时：起服务（被 import 时不自动起 —— 测试要能只用纯函数那一半） */
if (process.argv[1] && /canvasServer\.(ts|js)$/.test(process.argv[1].replace(/\\/g, "/"))) {
  const dataDir = canvasDataDir();
  const docFile = canvasDocPath(dataDir);
  /* 事件库就在同一个数据目录的会话库文件里（与桌面同一份 —— 环境变量指到同一个目录时） */
  const canvas = createCanvasStore(dataDir, "sessions.db");
  log(`画布文档：${docFile}（事件记进 ${dataDir}/sessions.db 的 canvas_events）`);
  await startServer({ docFile, canvas });
}
