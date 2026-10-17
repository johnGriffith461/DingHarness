import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { askAgentViaChannel } from "./agentClient";
import type { ImConfig } from "./config";
import { openSeenStore } from "./dedupe";
import { createFeishuReplier, decryptFeishu, parseFeishuEvent, verifyFeishuSignature } from "./feishu";
import { createSlackReplier, parseSlackEvent, verifySlackSignature } from "./slack";
import { handleIncoming, type IncomingMessage as ImMessage } from "./types";

/**
 * IM webhook 服务（V6-2f）。
 *
 * ## 为什么单独一个服务
 *
 * `ding serve` 的每条业务路由都要 Bearer 口令（fail-closed）。平台 webhook **带不了**
 * 我们的口令，它只有自己的签名 —— 把 webhook 混进那条服务等于在认证闸上开一个口子。
 * 所以独立一个端口：**平台签名 = 这一层的认证**，过了它才去调带口令的 Agent Server。
 *
 * ## 先 ACK、再干活
 *
 * 飞书/Slack 都要求几秒内回 200，否则重投。而 agent 一轮可能跑几分钟 ——
 * 所以事件一律**先回 200**，再异步处理；去重表在 ACK 前就落下（重投不会重复执行）。
 *
 * ## 默认只绑回环
 *
 * 本机优先：默认 `127.0.0.1`，公网暴露请走反向代理/隧道（`im.json` 的
 * `loopbackOnly:false` 才绑 `0.0.0.0`，并且必须自己清楚风险）。
 */

export type ImServerDeps = {
  config: ImConfig;
  /** 去重表文件。 */
  seenFile: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** 覆盖"问 agent"（测试注入；默认走 `/v1/channels`）。 */
  askAgent?: (message: ImMessage) => Promise<string>;
};

export type ImServer = {
  server: Server;
  /** 真正监听的端口（传 0 时是系统分配的）。 */
  port: () => number;
  close: () => Promise<void>;
};

const MAX_BODY = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body 太大（>1MB）"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 建一个 IM webhook 服务（不 listen；调用方决定端口）。 */
export function createImServer(deps: ImServerDeps): ImServer {
  const { config } = deps;
  const log = deps.log ?? ((line: string) => process.stderr.write(`[im] ${line}\n`));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const seen = openSeenStore(deps.seenFile);
  const allow = new Set(config.allowUsers ?? []);
  const allowed = (userId: string) => allow.size === 0 || allow.has(userId);

  const askAgent =
    deps.askAgent ??
    ((message: ImMessage) =>
      askAgentViaChannel({
        baseURL: config.agent.url,
        token: config.agent.token,
        channel: message.platform,
        from: message.userId,
        text: message.text,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }));

  const feishuReply = config.feishu ? createFeishuReplier(config.feishu, fetchImpl) : null;
  const slackReply = config.slack ? createSlackReplier(config.slack, fetchImpl) : null;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/healthz") {
        json(res, 200, {
          ok: true,
          platforms: [config.feishu ? "feishu" : "", config.slack ? "slack" : ""].filter(Boolean),
          seen: seen.size(),
          allowUsers: allow.size,
        });
        return;
      }

      if (req.method !== "POST") {
        json(res, 404, { error: "not found" });
        return;
      }

      /* ── 飞书 ── */
      if (url.pathname === "/im/feishu") {
        if (!config.feishu || !feishuReply) {
          json(res, 404, { error: "没有配置 feishu" });
          return;
        }
        const raw = await readBody(req);
        const headers = req.headers;
        if (
          !verifyFeishuSignature({
            timestamp: String(headers["x-lark-request-timestamp"] ?? ""),
            nonce: String(headers["x-lark-request-nonce"] ?? ""),
            signature: String(headers["x-lark-signature"] ?? ""),
            rawBody: raw,
            ...(config.feishu.encryptKey ? { encryptKey: config.feishu.encryptKey } : {}),
          })
        ) {
          log("飞书验签失败（拒绝）");
          json(res, 401, { error: "签名不对" });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
          if (body && typeof body === "object" && typeof (body as { encrypt?: unknown }).encrypt === "string") {
            if (!config.feishu.encryptKey) throw new Error("收到加密事件但没有配 encryptKey");
            body = decryptFeishu((body as { encrypt: string }).encrypt, config.feishu.encryptKey);
          }
        } catch (error) {
          log(`飞书事件解不开：${String((error as Error)?.message ?? error)}`);
          json(res, 400, { error: "事件解不开" });
          return;
        }

        const event = parseFeishuEvent(body, config.feishu.verificationToken);
        if (event.kind === "challenge") {
          json(res, 200, { challenge: event.challenge });
          return;
        }
        if (event.kind === "ignore") {
          json(res, 200, { ok: true, ignored: event.why });
          return;
        }
        if (!allowed(event.message.userId)) {
          log(`不在白名单：${event.message.userId}（不回）`);
          json(res, 200, { ok: true, ignored: "user not allowed" });
          return;
        }
        /* 先 ACK：agent 可能跑很久，平台等不了 */
        json(res, 200, { ok: true });
        void handleIncoming(event.message, { askAgent, reply: feishuReply, seen, log }).catch((error) =>
          log(`处理失败：${String((error as Error)?.message ?? error)}`),
        );
        return;
      }

      /* ── Slack ── */
      if (url.pathname === "/im/slack") {
        if (!config.slack || !slackReply) {
          json(res, 404, { error: "没有配置 slack" });
          return;
        }
        const raw = await readBody(req);
        const headers = req.headers;
        if (
          !verifySlackSignature({
            timestamp: String(headers["x-slack-request-timestamp"] ?? ""),
            signature: String(headers["x-slack-signature"] ?? ""),
            rawBody: raw,
            signingSecret: config.slack.signingSecret,
          })
        ) {
          log("Slack 验签失败（拒绝）");
          json(res, 401, { error: "签名不对" });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          json(res, 400, { error: "body 不是 JSON" });
          return;
        }
        const event = parseSlackEvent(body);
        if (event.kind === "challenge") {
          json(res, 200, { challenge: event.challenge });
          return;
        }
        if (event.kind === "ignore") {
          json(res, 200, { ok: true, ignored: event.why });
          return;
        }
        if (!allowed(event.message.userId)) {
          log(`不在白名单：${event.message.userId}（不回）`);
          json(res, 200, { ok: true, ignored: "user not allowed" });
          return;
        }
        json(res, 200, { ok: true });
        void handleIncoming(event.message, { askAgent, reply: slackReply, seen, log }).catch((error) =>
          log(`处理失败：${String((error as Error)?.message ?? error)}`),
        );
        return;
      }

      json(res, 404, { error: "not found" });
    })().catch((error) => {
      log(`请求处理异常：${String((error as Error)?.message ?? error)}`);
      json(res, 500, { error: "internal" });
    });
  });

  return {
    server,
    port: () => {
      const address = server.address();
      return typeof address === "object" && address ? address.port : 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
