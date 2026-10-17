import { createHmac, timingSafeEqual } from "node:crypto";

import type { IncomingMessage } from "./types";

/**
 * Slack 身份桥（V6-2f）。
 *
 * | 方向 | 形状 |
 * |---|---|
 * | 平台 → 桥 | `POST /im/slack`，头 `X-Slack-Request-Timestamp` / `X-Slack-Signature` |
 * | URL 校验 | body `{type:"url_verification", challenge}` → 回 `{challenge}` |
 * | 签名 | `v0=HMAC_SHA256(signingSecret, "v0:" + timestamp + ":" + rawBody)` |
 * | 桥 → 平台 | `chat.postMessage`（Bot User OAuth Token） |
 *
 * 时间戳必须落在 ±5 分钟内 —— 否则一个被截获的旧请求可以无限重放。
 */

export type SlackConfig = {
  signingSecret: string;
  botToken: string;
  /** 自定义 API 地址（默认 https://slack.com）。 */
  apiBase?: string;
};

/** 计算签名（十六进制，带 `v0=` 前缀）。 */
export function slackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

/**
 * 验签（含时间窗）。
 *
 * @param now 当前时间（测试注入；默认 Date.now）
 */
export function verifySlackSignature(input: {
  timestamp?: string;
  signature?: string;
  rawBody: string;
  signingSecret: string;
  now?: number;
}): boolean {
  if (!input.timestamp || !input.signature) return false;
  const ts = Number(input.timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const expected = slackSignature(input.signingSecret, input.timestamp, input.rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(input.signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 剥掉 Slack 的 `<@U123>` 提及。 */
export function stripSlackMentions(text: string): string {
  return String(text ?? "")
    .replace(/<@[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type SlackEvent =
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; message: IncomingMessage }
  | { kind: "ignore"; why: string };

/**
 * 解析一条 Slack 事件。
 *
 * @param body 事件体（已验签，但字段仍按不可信处理）
 */
export function parseSlackEvent(body: unknown): SlackEvent {
  if (!body || typeof body !== "object") return { kind: "ignore", why: "不是对象" };
  const b = body as Record<string, unknown>;
  if (b.type === "url_verification") {
    if (typeof b.challenge !== "string") return { kind: "ignore", why: "缺 challenge" };
    return { kind: "challenge", challenge: b.challenge };
  }
  if (b.type !== "event_callback") return { kind: "ignore", why: `不处理的事件：${String(b.type)}` };

  const event = (b.event ?? {}) as Record<string, unknown>;
  if (event.type !== "message") return { kind: "ignore", why: `不处理的消息类型：${String(event.type)}` };
  /* 机器人自己发的、编辑/加入频道等子类型：一律不处理（否则会自问自答） */
  if (event.bot_id || event.subtype) return { kind: "ignore", why: `忽略子类型/机器人消息：${String(event.subtype ?? "bot")}` };
  const text = stripSlackMentions(String(event.text ?? ""));
  const userId = String(event.user ?? "");
  const chatId = String(event.channel ?? "");
  const eventId = String(b.event_id ?? "");
  if (!text || !userId || !chatId || !eventId) return { kind: "ignore", why: "缺 user/channel/eventId/text" };
  return { kind: "message", message: { platform: "slack", eventId, userId, chatId, text } };
}

/** Slack 回复器。 */
export function createSlackReplier(
  config: SlackConfig,
  fetchImpl: typeof fetch = fetch,
): (message: IncomingMessage, reply: string) => Promise<{ ok: boolean; error?: string }> {
  const base = (config.apiBase ?? "https://slack.com").replace(/\/+$/, "");
  return async (message, reply) => {
    try {
      const response = await fetchImpl(`${base}/api/chat.postMessage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.botToken}` },
        body: JSON.stringify({ channel: message.chatId, text: reply.slice(0, 40_000) }),
      });
      const json = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !json.ok) return { ok: false, error: json.error ?? `HTTP ${response.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) };
    }
  };
}
