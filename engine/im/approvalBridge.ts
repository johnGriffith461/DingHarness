/**
 * **IM 审批卡的 HTTP 那一半**（G12 接线，承接 `approvalCards.ts` 的判定）。
 *
 * ## 一轮结束后做什么
 *
 * 不在这里改渠道 API 的推流形状：`/v1/channels` 跑完一轮就结束，服务端返回的
 * `done.reply` 是"这一轮说了什么"。若这一轮停在审批上，`GET /v1/approvals?session=`
 * 里就有待决 —— IM 桥**再查一次**，把每条待决变成一张卡发回群里，并登记短码。
 *
 * ## 为什么"先发卡、后等回复"而不是长连接
 *
 * IM 平台的 webhook 没有"服务端主动推给某个群"的通用通道（飞书/Slack 都要各自
 * 的 API 与权限）。本机版用**轮询式**：跑完一轮查一次待批。
 * 代价写清楚：**一轮中途产生的待批要等这一轮结束才发卡**；如果一轮因为等审批
 * 而迟迟不结束，卡就不会提前出现。这是如实记录的边界，不是"已经支持实时推送"。
 *
 * ## 判定不在这里
 *
 * 短码生成、first-come、过期全在 `approvalCards.ts`；这里只做
 * "读待批 / 发卡 / 收到回复去处置" 三件搬砖的事。
 */

import { channelSessionId } from "../../shared/channel";
import type { CardRegistry, PendingCard } from "./approvalCards";

/** 服务端返回的一条待决（只取要用的字段）。 */
export type ApprovalRow = {
  sessionId: string;
  toolCallId: string;
  name: string;
  state: string;
  approvers: string[];
  youCanDecide: boolean;
  createdAt: number;
  decidedBy?: string;
};

export type BridgeOptions = {
  baseURL: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function baseOf(opts: BridgeOptions): string {
  const base = opts.baseURL.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error(`agent 地址必须是 http(s)：${opts.baseURL}`);
  return base;
}

async function request(opts: BridgeOptions, path: string, init: RequestInit): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    return await doFetch(`${baseOf(opts)}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查一段会话的待决。
 *
 * @returns 待决列表；服务端没接审批索引（501）时返回空数组并带 `unsupported:true`
 */
export async function fetchPendingApprovals(
  opts: BridgeOptions,
  sessionId: string,
): Promise<{ rows: ApprovalRow[]; unsupported?: string; error?: string }> {
  try {
    const res = await request(opts, `/v1/approvals?session=${encodeURIComponent(sessionId)}`, { method: "GET" });
    if (res.status === 501) return { rows: [], unsupported: "服务端没接审批索引" };
    const body = (await res.json()) as { approvals?: unknown; error?: string };
    if (!res.ok) return { rows: [], error: body.error ?? `HTTP ${res.status}` };
    const rows = Array.isArray(body.approvals) ? (body.approvals as ApprovalRow[]) : [];
    return { rows: rows.filter((r) => r && r.state === "pending") };
  } catch (error) {
    return { rows: [], error: String((error as Error)?.message ?? error).slice(0, 200) };
  }
}

/**
 * 处置一条待批。
 *
 * @returns 成功与否 + 一句能直接回给用户的话
 */
export async function decideApproval(
  opts: BridgeOptions,
  input: { sessionId: string; toolCallId: string; approved: boolean; by: string },
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await request(
      opts,
      `/v1/approvals/${encodeURIComponent(input.sessionId)}/${encodeURIComponent(input.toolCallId)}`,
      { method: "POST", body: JSON.stringify({ action: input.approved ? "approve" : "reject", by: input.by }) },
    );
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; decidedBy?: string };
    if (!res.ok) {
      const why = body.detail ?? body.error ?? `HTTP ${res.status}`;
      return { ok: false, message: `这条没处置成：${why}` };
    }
    return {
      ok: true,
      message: input.approved ? "已批准 —— 服务端会接着把这一步做完。" : "已拒绝 —— 它得换别的办法。",
    };
  } catch (error) {
    return { ok: false, message: `没连上服务端：${String((error as Error)?.message ?? error).slice(0, 160)}` };
  }
}

/** 卡片正文（**不含工具参数正文**，只给"要干什么"的摘要）。 */
export function cardText(card: PendingCard, ttlMinutes = 10): string {
  return [
    `⚠️ 等你批准：${card.name}`,
    card.summary ? `　${card.summary}` : "",
    `回复 \`yes ${card.code}\` 批准，或 \`no ${card.code}\` 拒绝（${ttlMinutes} 分钟内有效）。`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 把一条服务端待决登记成本地卡（同一条 toolCallId 重复调用返回已有的那张）。
 *
 * @returns 新卡或已有卡；`youCanDecide` 为 false 时不登记（不是给我批的）
 */
export function registerCard(
  registry: CardRegistry,
  row: ApprovalRow,
  ctx: { chat: string; platform: string; channel: string; from: string; ttlMs?: number },
): PendingCard | null {
  if (!row.youCanDecide) return null;
  /* 摘要只放工具名与 id —— 服务端那侧没有给我们参数（那是它的边界，不是这里省事） */
  const summary = `会话 ${channelSessionId(ctx.channel, ctx.from)} · 调用 ${row.toolCallId}`;
  return registry.add({
    sessionId: row.sessionId,
    toolCallId: row.toolCallId,
    name: row.name,
    summary,
    chat: ctx.chat,
    platform: ctx.platform,
    ...(ctx.ttlMs === undefined ? {} : { ttlMs: ctx.ttlMs }),
  });
}
