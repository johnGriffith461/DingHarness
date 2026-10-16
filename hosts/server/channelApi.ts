import type { IncomingMessage, ServerResponse } from "node:http";

import { MAIN_AGENT, type Actor } from "../../engine/core/actor";
import type { RequesterIdentity, ServerOptions } from "./agentServer";

/**
 * **多渠道触发**（V5-3 任务 3.6）：外面的一条消息 → 事件入流 → 回执送回去。
 *
 * ## 形态
 *
 * ```
 * POST /v1/channels/<渠道>   { "from": "<终端用户 id>", "text": "…", "sessionId?": "…" }
 *   → SSE：started / event… / done（done 里带 reply）
 * ```
 *
 * 渠道适配器（Telegram / 企微 / …）是**这一层外面的薄壳**：它们把平台消息翻译成这一条
 * HTTP，再把 SSE 里的 `reply` 发回群里。本机版**没有**接真平台凭据 —— 这一层给的是
 * "一条消息触发 → 事件进流 → 回执出得去"的**通路**，以及它在真实平台上的接线点
 * （channel 名字是适配器的名字）。
 *
 * ## 三层身份在这条路上的落点
 *
 * | 层 | 谁 | 从哪来 |
 * |---|---|---|
 * | user | 渠道桥（那台机器上跑着适配器的人/进程） | Bearer 口令（2.2 认出来的身份） |
 * | end_user | **外面那个发消息的人** | body 的 `from` |
 * | account | 空间/账目 | 会话归属（`/v1/usage` 那侧） |
 *
 * 会话 id 用 `ch:<渠道>:<发送者>`：同一渠道同一个人接着聊；不同渠道/不同人各自一段。
 * 这个前缀也是账本那侧认 end_user 的依据（`endUserFromSessionId`）。
 */

/** 渠道会话 id（同一渠道同一个人一段会话）。 */
export function channelSessionId(channel: string, from: string): string {
  const safe = (x: string) => x.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `ch-${safe(channel)}-${safe(from)}`;
}

/**
 * 从会话 id 里认回"外面那个人"（账本与审计那侧用）。
 *
 * @param sessionId 会话 id
 * @returns `渠道:发送者`；不是渠道会话给 null
 */
export function endUserFromSessionId(sessionId: string): { channel: string; endUser: string } | null {
  const m = /^ch-([A-Za-z0-9._-]+)-([A-Za-z0-9._-]+)$/.exec(sessionId);
  if (!m) return null;
  return { channel: m[1]!, endUser: m[2]! };
}

/** 渠道名的形状（它进会话 id 与日志）。 */
const CHANNEL_OK = /^[A-Za-z0-9._-]{1,32}$/;

export type ChannelApiCtx = {
  opts: ServerOptions;
  identity: RequesterIdentity;
  activeRuns: Set<AbortController>;
  runsByActor: Map<string, Set<AbortController>>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<Buffer>;
  note: (text: string) => void;
};

/**
 * 处理 `POST /v1/channels/<渠道>`。
 *
 * @returns 处理了就给 true
 */
export async function handleChannelRoute(
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChannelApiCtx,
): Promise<boolean> {
  const m = /^\/v1\/channels\/([^/]+)$/.exec(path);
  if (!m || req.method !== "POST") return false;
  const { json, note } = ctx;

  const channel = decodeURIComponent(m[1]!);
  if (!CHANNEL_OK.test(channel)) {
    note("渠道名形状不对");
    json(res, 400, { error: "渠道名只接受 1–32 个字母/数字/._-" });
    return true;
  }
  const raw = await ctx.readBody(req);
  let body: { from?: unknown; text?: unknown; sessionId?: unknown } = {};
  try {
    body = JSON.parse(raw.toString("utf8") || "{}") as typeof body;
  } catch {
    note("渠道 body 不是 JSON");
    json(res, 400, { error: "body 必须是 JSON：{from, text, sessionId?}" });
    return true;
  }
  const from = typeof body.from === "string" ? body.from.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!from || !text) {
    note("渠道消息缺 from/text");
    json(res, 400, { error: "要 from（外面那个人）与 text（消息正文）" });
    return true;
  }
  const sessionId =
    typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : channelSessionId(channel, from);

  /* 与 /v1/run 同一套装置（句柄、按人登记、SSE）—— 只是入口多带了"外面那个人" */
  await runChannelTurn(res, ctx, { channel, from, text, sessionId });
  return true;
}

/** 跑一轮渠道回合（复用 `runApi` 的推流形状，但带 `from`）。 */
async function runChannelTurn(
  res: ServerResponse,
  ctx: ChannelApiCtx,
  input: { channel: string; from: string; text: string; sessionId: string },
): Promise<void> {
  const { opts, identity, note } = ctx;
  note(`渠道 ${input.channel}：${input.from} → ${input.sessionId}`);
  /* 懒加载 runApi 的推流：那一份的实现只认"消息 + 身份"，渠道只是多带了 from */
  const { runStreaming } = await import("./runApi");
  const requester: Actor = { id: identity.id, kind: "user" };

  /*
   * 渠道回合**复用 `/v1/run` 那条出口**（同一套 SSE、同一套记录、同一个 actor 口径）——
   * 唯一多的是把"外面那个人"写进会话 id（见 `channelSessionId`），
   * 而账本那侧从会话 id 认回 end_user。这样"渠道消息"与"本机消息"走的是同一条流水线，
   * 不另造一条（另造的那条一定会与这条漂）。
   */
  await runStreaming(res, opts, input.text, opts.cwd, input.sessionId, ctx.activeRuns, identity, ctx.runsByActor, {
    /* 渠道来源进 SSE 的 started 帧（桥要能确认"这轮回执是发给谁的"） */
    channel: input.channel,
    from: input.from,
    actor: requester,
  });
}

/** 渠道回合的 SSE 里，`done` 帧带 `reply` 的依据（回执送达的内容）。 */
export const CHANNEL_REPLY_NOTE =
  "回执在 done 帧的 reply 里（桥把它发回群里）；事件流与日志和本机对话同一条口径。";

/** 把一条消息翻译成渠道请求（给适配器写的薄壳用的形状文档）。 */
export type ChannelMessage = { channel: string; from: string; text: string; sessionId?: string };

/** 供适配器参考：渠道名与人话的对照（本机版只有通用 HTTP；真平台适配器要外部凭据）。 */
export const KNOWN_CHANNELS = ["telegram", "wecom", "webhook", "generic"] as const;

export { MAIN_AGENT };
