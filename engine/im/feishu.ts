import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

import type { IncomingMessage } from "./types";

/**
 * 飞书（Lark）身份桥（V6-2f）。
 *
 * ## 协议口径（官方事件订阅 v2）
 *
 * | 方向 | 形状 |
 * |---|---|
 * | 平台 → 桥 | `POST /im/feishu`，头 `X-Lark-Request-Timestamp` / `X-Lark-Request-Nonce` / `X-Lark-Signature` |
 * | URL 校验 | body `{type:"url_verification", challenge, token}` → 原样回 `{challenge}` |
 * | 加密事件 | body `{encrypt:"<base64>"}` → AES-256-CBC（key = sha256(encryptKey)，IV = 前 16 字节） |
 * | 桥 → 平台 | `tenant_access_token/internal` 取 token → `im/v1/messages?receive_id_type=chat_id` 发文本 |
 *
 * 签名 = `sha256(timestamp + nonce + encryptKey + rawBody)`（十六进制）。
 * 配了 encryptKey 就必须验签；没配则只校验 verificationToken（飞书此时也不带加密）。
 */

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  /** 事件订阅页填的 Verification Token。 */
  verificationToken: string;
  /** 事件加密 Key（可选；配了就要求签名与解密）。 */
  encryptKey?: string;
  /** 自定义开放平台地址（默认 https://open.feishu.cn）。 */
  apiBase?: string;
};

/** 计算签名。 */
export function feishuSignature(timestamp: string, nonce: string, encryptKey: string, rawBody: string): string {
  return createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${rawBody}`).digest("hex");
}

/**
 * 验签（常数时间比较）。
 *
 * @returns 通过返回 true；配置了 encryptKey 而头缺失/不匹配 → false
 */
export function verifyFeishuSignature(input: {
  timestamp?: string;
  nonce?: string;
  signature?: string;
  rawBody: string;
  encryptKey?: string;
}): boolean {
  if (!input.encryptKey) return true; // 未启用加密：飞书不带签名，token 校验即可
  if (!input.timestamp || !input.nonce || !input.signature) return false;
  const expected = feishuSignature(input.timestamp, input.nonce, input.encryptKey, input.rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(input.signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 解密事件体。 */
export function decryptFeishu(encrypted: string, encryptKey: string): unknown {
  const key = createHash("sha256").update(encryptKey).digest();
  const buffer = Buffer.from(encrypted, "base64");
  if (buffer.length <= 16) throw new Error("密文太短（不是合法的飞书加密事件）");
  const iv = buffer.subarray(0, 16);
  const data = buffer.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const text = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  return JSON.parse(text) as unknown;
}

/** 事件解析结果。 */
export type FeishuEvent =
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; message: IncomingMessage }
  | { kind: "ignore"; why: string };

/** 剥掉飞书文本里的 @ 标记（`<at user_id="...">名字</at>`）。 */
export function stripFeishuMentions(text: string): string {
  return String(text ?? "")
    .replace(/<at\b[^>]*>.*?<\/at>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 解析一条飞书事件（已解密后的 JSON）。
 *
 * @param body 事件体（不可信）
 * @param verificationToken 配置里的 token（用来校验）
 */
export function parseFeishuEvent(body: unknown, verificationToken: string): FeishuEvent {
  if (!body || typeof body !== "object") return { kind: "ignore", why: "不是对象" };
  const b = body as Record<string, unknown>;

  /* URL 校验：飞书的 token 在 body 顶层 */
  if (b.type === "url_verification") {
    if (typeof b.challenge !== "string") return { kind: "ignore", why: "url_verification 缺 challenge" };
    if (typeof b.token === "string" && verificationToken && b.token !== verificationToken) {
      return { kind: "ignore", why: "verification token 不匹配" };
    }
    return { kind: "challenge", challenge: b.challenge };
  }

  const header = (b.header ?? {}) as Record<string, unknown>;
  if (header.token !== undefined && verificationToken && header.token !== verificationToken) {
    return { kind: "ignore", why: "verification token 不匹配" };
  }
  const eventType = String(header.event_type ?? "");
  if (eventType && eventType !== "im.message.receive_v1") return { kind: "ignore", why: `不处理的事件：${eventType}` };

  const event = (b.event ?? {}) as Record<string, unknown>;
  const message = (event.message ?? {}) as Record<string, unknown>;
  const sender = (event.sender ?? {}) as Record<string, unknown>;
  const senderId = (sender.sender_id ?? {}) as Record<string, unknown>;
  const chatId = String(message.chat_id ?? "");
  const userId = String(senderId.open_id ?? senderId.user_id ?? "");
  const eventId = String(header.event_id ?? message.message_id ?? "");
  const messageType = String(message.message_type ?? "text");
  if (messageType !== "text") return { kind: "ignore", why: `不处理的消息类型：${messageType}` };

  let text = "";
  try {
    const content = typeof message.content === "string" ? (JSON.parse(message.content) as { text?: unknown }) : (message.content as { text?: unknown });
    text = typeof content?.text === "string" ? stripFeishuMentions(content.text) : "";
  } catch {
    return { kind: "ignore", why: "消息 content 不是合法 JSON" };
  }
  if (!userId || !chatId || !eventId || !text) return { kind: "ignore", why: "缺 user/chat/eventId/text" };

  return { kind: "message", message: { platform: "feishu", eventId, userId, chatId, text } };
}

/** 取 tenant_access_token（带进程内缓存）。 */
export function createFeishuTokenSource(config: FeishuConfig, fetchImpl: typeof fetch = fetch): () => Promise<string> {
  const base = (config.apiBase ?? "https://open.feishu.cn").replace(/\/+$/, "");
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
    const response = await fetchImpl(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    });
    const json = (await response.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!response.ok || json.code !== 0 || !json.tenant_access_token) {
      throw new Error(`取 tenant_access_token 失败：${json.msg ?? `HTTP ${response.status}`}`);
    }
    const ttl = Number(json.expire ?? 7200) * 1000;
    cached = { token: json.tenant_access_token, expiresAt: Date.now() + ttl };
    return cached.token;
  };
}

/** 飞书回复器（bot 以自己身份发消息）。 */
export function createFeishuReplier(
  config: FeishuConfig,
  fetchImpl: typeof fetch = fetch,
): (message: IncomingMessage, reply: string) => Promise<{ ok: boolean; error?: string }> {
  const base = (config.apiBase ?? "https://open.feishu.cn").replace(/\/+$/, "");
  const tokenOf = createFeishuTokenSource(config, fetchImpl);
  return async (message, reply) => {
    try {
      const token = await tokenOf();
      const response = await fetchImpl(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          receive_id: message.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: reply.slice(0, 20_000) }),
        }),
      });
      const json = (await response.json()) as { code?: number; msg?: string };
      if (!response.ok || json.code !== 0) return { ok: false, error: json.msg ?? `HTTP ${response.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) };
    }
  };
}
