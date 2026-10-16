import type { IncomingMessage, ServerResponse } from "node:http";

import type { SyncRelay } from "../../engine/sync/relay";

/**
 * **同步中继的 HTTP 面**（V5-2 2.1）：`/v1/streams/*` 那一族。
 *
 * 从 `agentServer.ts` 拆出来（那个文件贴着 900 行上限，而这一族路由自成一块）。
 * 这一层**只搬运**：协议语义（去重 / fencing / gap / 引用门）一个字都不在这里重写 ——
 * 判定全在 `engine/sync/relay.ts`，这里只把它的返回值搬上网。
 *
 * 中继没接线就**回 501**（与 `/v1/sessions` 同一个口径：不假装一条空流）。
 */

export type StreamApiCtx = {
  relay: SyncRelay | undefined;
  /** json 助手（由 agentServer 注入） */
  json: (res: ServerResponse, status: number, body: unknown) => void;
  /** safeDecode（由 agentServer 注入：坏百分号编码回 400 而不是 500） */
  safeDecode: (segment: string) => string | null;
  readBody: (req: IncomingMessage) => Promise<Buffer>;
  note: (text: string) => void;
};

/**
 * 处理一条 `/v1/streams/*` 请求。
 *
 * @returns 处理了就给 true（响应已写）
 */
export async function handleStreamRoute(
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: StreamApiCtx,
): Promise<boolean> {
  const streamPath = /^\/v1\/streams\/([^/]+)(\/(push|pull|claim))?$/.exec(path);
  if (!streamPath) return false;

  if (!ctx.relay) {
    ctx.note("streams 未接线");
    ctx.json(res, 501, { error: "这个服务没有接同步中继（宿主没把 relay 交给它）" });
    return true;
  }
  const relay = ctx.relay;
  const streamId = ctx.safeDecode(streamPath[1]!);
  if (streamId === null) {
    ctx.note("流 id 解码不了");
    ctx.json(res, 400, { error: "流 id 的百分号编码不合法（解码失败）" });
    return true;
  }
  const action = streamPath[3];

  if (!action && req.method === "PUT") {
    const created = relay.createStream(streamId);
    ctx.note(created.ok ? "建流" : "流 id 形状不对");
    ctx.json(res, created.ok ? 200 : 400, created.ok ? { ok: true, streamId } : { error: created.message });
    return true;
  }
  if (!action && req.method === "GET") {
    const state = relay.state(streamId);
    ctx.note(state ? `流 ${streamId}` : "没有这条流");
    ctx.json(res, state ? 200 : 404, state ? { state } : { error: `没有这条流：${streamId}` });
    return true;
  }
  if (action === "claim" && req.method === "POST") {
    const raw = await ctx.readBody(req);
    let body: { holder?: unknown } = {};
    try {
      body = JSON.parse(raw.toString("utf8") || "{}") as typeof body;
    } catch {
      ctx.note("body 不是 JSON");
      ctx.json(res, 400, { error: 'body 必须是 JSON：{"holder":"端名"}' });
      return true;
    }
    const got = relay.claim(streamId, String(body.holder ?? ""));
    ctx.note(got.ok ? `接管：epoch ${got.epoch}` : "没有这条流");
    ctx.json(res, got.ok ? 200 : 404, got.ok ? got : { error: got.message });
    return true;
  }
  if (action === "push" && req.method === "POST") {
    const raw = await ctx.readBody(req);
    let body: { producerId?: unknown; epoch?: unknown; events?: unknown } = {};
    try {
      body = JSON.parse(raw.toString("utf8") || "{}") as typeof body;
    } catch {
      ctx.note("body 不是 JSON");
      ctx.json(res, 400, { error: "body 必须是 JSON：{producerId, epoch, events:[{seq,type,payload}]}" });
      return true;
    }
    if (typeof body.producerId !== "string" || !Array.isArray(body.events)) {
      ctx.note("push 参数不全");
      ctx.json(res, 400, { error: "push 需要 producerId（字符串）、epoch（数字）与 events（数组）" });
      return true;
    }
    const got = relay.push(streamId, {
      producerId: body.producerId,
      epoch: Number(body.epoch ?? 0),
      events: body.events as Parameters<SyncRelay["push"]>[1]["events"],
    });
    /*
     * 协议层的拒绝（fenced/gap/too-large…）用 **409**：请求本身没毛病，是状态不允许 ——
     * 调用方按 code 处理（"参数不对"那类才是 400，两者别混）。
     */
    ctx.note(got.ok ? `收 ${got.accepted} 条（重复 ${got.duplicates}）` : `${got.code}`);
    ctx.json(res, got.ok ? 200 : 409, got);
    return true;
  }
  if (action === "pull" && req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const from = Number(url.searchParams.get("from") ?? "0");
    const limitRaw = url.searchParams.get("limit");
    const got = relay.pull(streamId, {
      from: Number.isFinite(from) ? from : 0,
      ...(limitRaw === null ? {} : { limit: Number(limitRaw) }),
    });
    ctx.note(got.ok ? `${got.events.length} 条` : "没有这条流");
    ctx.json(res, got.ok ? 200 : 404, got.ok ? got : { error: got.message });
    return true;
  }

  ctx.note("streams 用错了方法/动作");
  ctx.json(res, 405, {
    error: `不支持 ${req.method} ${path}（可用：PUT 建流 / POST claim / POST push / GET pull / GET 状态）`,
  });
  return true;
}
