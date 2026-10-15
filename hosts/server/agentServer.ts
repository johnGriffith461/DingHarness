import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Engine } from "../../engine/index";
import { humanFailure } from "../../shared/errors";
import type { ConfirmMode } from "../../shared/ipc";

/**
 * Agent Server（Phase 17）——把内核暴露成一个本机 HTTP 服务。
 *
 * ## 三条安全口径（方案原文，逐条落地）
 *
 * 1. **默认只绑回环**（`127.0.0.1`）。要对外必须**显式**给 `--bind`；
 * 2. **对外绑定时必须有 token**：没有 token 的公开服务等于把 agent 送给整个局域网
 *    （它能读你的文件、跑命令 —— 比"接口泄露"严重得多）。这条是**硬拒**，不是警告；
 * 3. **token 走 `Authorization: Bearer`**，比较用**常数时间**（别让响应时间泄露前缀）。
 *
 * ## 接口（够用就好，不是"什么都暴露"）
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET | `/healthz` | 活着吗（不需要 token —— 探活用） |
 * | GET | `/v1/info` | 这家 agent 是谁、什么能力、当前档位 |
 * | GET | `/v1/sessions` | 会话列表 |
 * | GET | `/v1/sessions/:id` | 一段会话的记录 |
 * | POST | `/v1/run` | 跑一轮，**SSE 流式**回事件（`text/event-stream`） |
 * | POST | `/v1/hooks/:name` | webhook 触发器：跑一条预置的提示词 |
 *
 * ## 与内核的关系
 *
 * 与 CLI / 桌面**同一份装配**（`makeEngine` 由宿主注入）—— 所以"接入外部宿主后
 * 评测集零漂移"是结构上的事，不是接完再验的事。
 */

/** 服务端配置。 */
export type ServerOptions = {
  port: number;
  /** 绑哪个地址。默认 `127.0.0.1`（只回环）。 */
  bind?: string;
  /** 对外绑定时**必须**给（见文件头第 2 条）。 */
  token?: string;
  /** 每建一次引擎（工作目录 → 引擎）。 */
  makeEngine: (cwd: string) => Promise<{ engine: Engine; close: () => void }>;
  mode: ConfirmMode;
  provider: string;
  model?: string;
  /** 工作目录（`/v1/run` 没给 cwd 时用它）。 */
  cwd: string;
  /** webhook 名字 → 要跑的提示词。 */
  hooks?: Record<string, string>;
  log?: (line: string) => void;
};

/** 起一个服务。返回句柄（端口可能被系统改过 —— 传 0 时就是随机端口）。 */
export async function startAgentServer(opts: ServerOptions): Promise<{ server: Server; port: number; url: string }> {
  const bind = opts.bind?.trim() || "127.0.0.1";
  const isLoopback = bind === "127.0.0.1" || bind === "::1" || bind === "localhost";

  /*
   * ⭐ **对外绑定必须有 token**：这是"别把 agent 送给整个局域网"那条。
   * 放在这里（起服务之前）而不是每个请求里 —— 配错了就不该起来。
   */
  if (!isLoopback && !opts.token?.trim()) {
    throw new Error(
      "绑到非回环地址时必须给 --token：agent 能读写你的文件、执行命令，" +
        "一个没有认证的公开服务等于把这些交给整个网络。要本机用就别给 --bind（默认只回环）。",
    );
  }

  const server = createServer((req, res) => {
    void handle(req, res, opts, Boolean(opts.token?.trim()));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, bind, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${port}` };
}

/** 常数时间比较（别让响应时间泄露 token 前缀）。 */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const got = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return Boolean(got) && sameToken(got, token);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** 读请求体（有上限：别让人用一个超大 body 把内存吃光）。 */
function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`请求体超过上限 ${limit} 字节`));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  needsToken: boolean,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  /* 探活不需要 token（否则负载均衡器/监控用不了） */
  if (path === "/healthz") {
    json(res, 200, { ok: true });
    return;
  }

  if (needsToken && !authorized(req, opts.token!)) {
    json(res, 401, { error: "需要 Authorization: Bearer <token>" });
    return;
  }

  try {
    if (path === "/v1/info" && req.method === "GET") {
      json(res, 200, {
        name: "ding-harness",
        version: "0.4.0",
        provider: opts.provider,
        ...(opts.model ? { model: opts.model } : {}),
        /** 当前闸门档位（外部宿主该知道"写与执行会不会被拦"）。 */
        mode: opts.mode,
        cwd: opts.cwd,
        hooks: Object.keys(opts.hooks ?? {}),
      });
      return;
    }

    if (path === "/v1/sessions" && req.method === "GET") {
      const built = await opts.makeEngine(opts.cwd);
      try {
        json(res, 200, { sessions: await listSessions(built.engine) });
      } finally {
        built.close();
      }
      return;
    }

    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch && req.method === "GET") {
      const id = decodeURIComponent(sessionMatch[1]!);
      const built = await opts.makeEngine(opts.cwd);
      try {
        const resumed = await built.engine.resume(id);
        json(res, 200, { sessionId: id, turns: resumed.turns.length, pending: resumed.pending.length });
      } finally {
        built.close();
      }
      return;
    }

    if (path === "/v1/run" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { message?: unknown; cwd?: unknown; sessionId?: unknown };
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        json(res, 400, { error: "要一个非空的 message" });
        return;
      }
      await runStreaming(res, opts, message, typeof body.cwd === "string" ? body.cwd : opts.cwd, typeof body.sessionId === "string" ? body.sessionId : undefined);
      return;
    }

    const hookMatch = /^\/v1\/hooks\/([^/]+)$/.exec(path);
    if (hookMatch && req.method === "POST") {
      const name = decodeURIComponent(hookMatch[1]!);
      const prompt = opts.hooks?.[name];
      if (!prompt) {
        json(res, 404, { error: `没有这个 hook：${name}（可用的：${Object.keys(opts.hooks ?? {}).join(" / ") || "（一个都没配）"}）` });
        return;
      }
      await runStreaming(res, opts, prompt, opts.cwd, undefined);
      return;
    }

    json(res, 404, { error: `没有这个路径：${req.method} ${path}` });
  } catch (error) {
    json(res, 500, { error: humanFailure(String((error as Error)?.message ?? error)) });
  }
}

/**
 * 列会话。
 *
 * ⚠️ **如实返回空数组**：`Engine` 端口上没有"列全部会话"这个方法（那是 `SessionStore`
 * 的活，而宿主没把它交给 HTTP 层）。与其在这里编一个假的列表，
 * 不如让这个接口先返回空 —— 调用方看得到"它现在不提供这个"，而不是以为"一台机器上一个会话都没有"。
 *
 * （补上它需要在宿主把 store 也交给这一层；那是下一步的事，不是这里糊一个。）
 */
async function listSessions(engine: Engine): Promise<Array<{ sessionId: string; turns: number }>> {
  void engine;
  return [];
}

/** 跑一轮并把事件以 SSE 推出去。 */
async function runStreaming(
  res: ServerResponse,
  opts: ServerOptions,
  message: string,
  cwd: string,
  sessionId: string | undefined,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const built = await opts.makeEngine(cwd);
  try {
    const outcome = await built.engine.run({
      ...(sessionId ? { sessionId } : {}),
      provider: opts.provider,
      ...(opts.model ? { model: opts.model } : {}),
      messages: [{ role: "user", content: message }],
      mode: opts.mode,
      useTools: true,
      maxSteps: 8,
      onEvent: (event) => send("event", event),
    });
    send("done", {
      ok: outcome.ok,
      aborted: outcome.aborted,
      ...(outcome.error ? { error: humanFailure(outcome.error) } : {}),
    });
  } catch (error) {
    send("done", { ok: false, error: humanFailure(String((error as Error)?.message ?? error)) });
  } finally {
    built.close();
    res.end();
  }
}
