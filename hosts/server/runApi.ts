import type { IncomingMessage, ServerResponse } from "node:http";

import { MAIN_AGENT, type Actor } from "../../engine/core/actor";
import { humanFailure } from "../../shared/errors";
import type { RequesterIdentity, ServerOptions } from "./agentServer";
import { canWriteSession, spaceOf } from "./spaceApi";

/**
 * **跑一轮的两条入口**（`/v1/run` 与 webhook `/v1/hooks/:name`）+ SSE 推流。
 *
 * 从 `agentServer.ts` 拆出来（贴着 900 行上限；这一块自成一体：两条入口共用
 * `runStreaming`，而它们与鉴权/路由那一层的关系只是"被调用"）。
 */

/** 本地主人那个 id（与 C1 的 owner / C4 的归属 / C5 的 actor 同一个 id 空间）。 */
const LOCAL_OWNER_ID = "local";

/** sessionId 白名单（它会被写进会话库；杂字符没有存在的理由）。 */
export const SESSION_ID_OK = /^[A-Za-z0-9._:-]{1,200}$/;

export type RunApiCtx = {
  opts: ServerOptions;
  identity: RequesterIdentity;
  activeRuns: Set<AbortController>;
  runsByActor: Map<string, Set<AbortController>>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<Buffer>;
  safeDecode: (segment: string) => string | null;
  signatureOk: (raw: Buffer, header: unknown, secret: string) => boolean;
  note: (text: string) => void;
};

/**
 * `/v1/run`（POST）。
 *
 * @returns 处理了就给 true
 */
export async function handleRunRoute(
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunApiCtx,
): Promise<boolean> {
  if (path !== "/v1/run" || req.method !== "POST") return false;
  const { opts, json, note, identity } = ctx;
  const raw = await ctx.readBody(req);
  let body: { message?: unknown; cwd?: unknown; sessionId?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8") || "{}") as typeof body;
  } catch {
    note("请求体不是 JSON");
    json(res, 400, { error: "请求体不是合法 JSON" });
    return true;
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    note("缺 message");
    json(res, 400, { error: "要一个非空的 message" });
    return true;
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
  if (sessionId !== undefined && !SESSION_ID_OK.test(sessionId)) {
    note("sessionId 形状不对");
    json(res, 400, { error: "sessionId 只接受 1–200 个字母/数字/._:- 字符" });
    return true;
  }
  const cwd = typeof body.cwd === "string" ? body.cwd : opts.cwd;
  note(`run${sessionId ? ` session=${sessionId}` : ""}`);
  /*
   * 写侧规则（V5-3 3.2）：主人写任何会话；成员只能写**自己的**、
   * 或**共享出来且他是当前持有人**的那段（接管语义）。
   * 先拒比"跑完发现记不进去"诚实 —— 归属冲突在 C1 是硬墙。
   */
  if (!identity.owner && sessionId) {
    const owned = opts.listSessions ? (await opts.listSessions()).find((x) => x.sessionId === sessionId) : undefined;
    const space = opts.space ? spaceOf(opts.space) : null;
    const allowed = canWriteSession(
      space ?? { roster: { owner: identity.id, members: [], codes: [] }, tokens: {}, shared: [], sharedRecipes: [], holders: {}, rooms: {} },
      identity,
      sessionId,
      owned?.owner,
    );
    if (!allowed) {
      note(`成员 ${identity.id} 想写 ${owned?.owner ?? "?"} 的会话`);
      json(res, 403, {
        error: `这段会话归 ${owned?.owner ?? LOCAL_OWNER_ID}，你写不进去（你是 ${identity.id}）—— 要写得先让它共享出去并接管`,
      });
      return true;
    }
  }
  await runStreaming(res, opts, message, cwd, sessionId, ctx.activeRuns, identity, ctx.runsByActor);
  return true;
}

/**
 * webhook（POST `/v1/hooks/:name`）。
 *
 * @returns 处理了就给 true
 */
export async function handleHookRoute(
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunApiCtx,
): Promise<boolean> {
  const hookMatch = /^\/v1\/hooks\/([^/]+)$/.exec(path);
  if (!hookMatch || req.method !== "POST") return false;
  const { opts, json, note, identity } = ctx;
  const name = ctx.safeDecode(hookMatch[1]!) ?? "";
  if (!name) {
    note("hook 名字解码不了");
    json(res, 400, { error: "hook 名字的百分号编码不合法（解码失败）" });
    return true;
  }
  /*
   * ⚠️ 用 `Object.hasOwn` 而不是真值判断：`opts.hooks` 是普通对象字面量，
   * `hooks["constructor"]` 会命中 `Object` 构造函数（truthy）——
   * 于是 `POST /v1/hooks/constructor` 能穿过"只跑配过的名字"这道门（审计 P182）。
   */
  if (!opts.hooks || !Object.hasOwn(opts.hooks, name)) {
    note(`hook 不存在：${name}`);
    json(res, 404, {
      error: `没有这个 hook：${name}（可用的：${Object.keys(opts.hooks ?? {}).join(" / ") || "（一个都没配）"}）`,
    });
    return true;
  }
  const raw = await ctx.readBody(req);
  /*
   * ⭐ webhook **一律验签**：没配密钥就整体拒绝（缺省 fail-closed），
   * 配了密钥但缺签名/签名不对同样 403。
   */
  const secret = opts.hooksSecret?.trim() ?? "";
  if (!secret || !ctx.signatureOk(raw, req.headers["x-hub-signature-256"], secret)) {
    note(`hook ${name} 签名不通过`);
    json(res, 403, {
      error: secret
        ? "webhook 必须带 X-Hub-Signature-256 签名（HMAC-SHA256，对请求体的原始字节）"
        : "服务没配 webhook 密钥（--hook-secret / DH_HOOK_SECRET）：webhook 一律拒绝",
    });
    return true;
  }
  note(`hook=${name}`);
  await runStreaming(res, opts, opts.hooks[name]!, opts.cwd, undefined, ctx.activeRuns, identity, ctx.runsByActor);
  return true;
}

/**
 * 跑一轮并把事件以 SSE 推出去。
 *
 * ⚠️ 三件事按这个顺序：**先建引擎，再写 200 的 SSE 头**。反过来的话，
 * 建引擎失败时头已经发出去，只能掐连接（客户端看到的是"流突然断了"，
 * 而不是一句能看懂的错）。
 *
 * ⚠️ 客户端断开（`res` close）→ `abort()`：这一轮**真的停下**。
 * 原来没有取消通道 —— 断开之后回合继续跑完，孤儿回合持续烧钱且杀不掉（审计 P171）。
 */
/** 从这一轮的事件里取"回执正文"（把 text 片段拼起来 —— 与界面看到的是同一份内容）。 */
export function replyTextOf(events: ReadonlyArray<{ type?: string; text?: unknown }>): string {
  return events
    .filter((e) => e.type === "text" && typeof e.text === "string")
    .map((e) => String(e.text))
    .join("")
    .trim();
}

export async function runStreaming(
  res: ServerResponse,
  opts: ServerOptions,
  message: string,
  cwd: string,
  sessionId: string | undefined,
  activeRuns: Set<AbortController>,
  identity: RequesterIdentity,
  runsByActor: Map<string, Set<AbortController>>,
  /**
   * 额外塞进 `started` 帧的字段（V5-3 3.6 的渠道：channel / from）——
   * 默认什么都不加（本机 `/v1/run` 那条与从前一字不差）。
   */
  extraStarted?: Record<string, unknown>,
): Promise<void> {
  /*
   * V5-2 2.3：**事件流带上 actor 维度**（谁发起的、谁在答）。
   * 与日志同一条口径（C5）：人那一侧 = 请求者身份（2.2 认出来的）、
   * agent 那一侧 = 主循环（`MAIN_AGENT`，与内核记日志用的是同一个常量）。
   */
  const requester: Actor = { id: identity.id, kind: "user" };

  /* 建引擎（cwd 不在授权范围会抛 CwdNotAllowedError → 外层翻成 400，且此时还没开头） */
  const built = await opts.makeEngine(cwd);

  const controller = new AbortController();
  activeRuns.add(controller);
  /* 按人登记（V5-3 3.5：撤销成员时 `abortRunsOf` 靠它关掉在跑的通道） */
  const mine = runsByActor.get(identity.id) ?? new Set<AbortController>();
  mine.add(controller);
  runsByActor.set(identity.id, mine);

  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", onClose);

  /* 建引擎期间客户端就走掉了：这一轮不用跑（也别再去写一条已经没了的连接） */
  if (res.destroyed || res.writableEnded) {
    res.off("close", onClose);
    activeRuns.delete(controller);
    mine.delete(controller);
    built.close();
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  /** 这一轮说出来的正文（从事件流里攒 —— 与界面看到的同一份；`done.reply` 用它）。 */
  let spoken = "";
  const send = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  /*
   * 第一帧：**这一轮是谁发起的**（V5-2 2.3；协作场景里"群里谁问的"必须看得见）。
   * 新增一种帧类型是加法：旧客户端认不出就跳过。
   */
  send("started", { actor: requester, ...(sessionId ? { sessionId } : {}), ...(extraStarted ?? {}) });

  try {
    const outcome = await built.engine.run({
      ...(sessionId ? { sessionId } : {}),
      /* C5/C1 的接线：这一轮的记录归发起人；**新会话也归他**（已有会话的归属不会被改） */
      actor: requester,
      ownerActor: requester,
      provider: opts.provider,
      ...(opts.model ? { model: opts.model } : {}),
      messages: [{ role: "user", content: message }],
      mode: opts.mode,
      useTools: true,
      maxSteps: 8,
      abortSignal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text" && typeof (event as { text?: unknown }).text === "string") {
          spoken += (event as { text: string }).text;
        }
        send("event", { ...event, actor: MAIN_AGENT });
      },
    });
    send("done", {
      ok: outcome.ok,
      aborted: outcome.aborted,
      actor: MAIN_AGENT,
      cwd, // 生效的工作目录（审计 P181：不回显的话，客户端看不出目录被换过）
      /*
       * 回执正文（渠道那侧把它发回群里；本机那侧当"这一轮说了什么"的手边副本）。
       * 从**流里攒**而不是只读 `outcome.events`：两者对真引擎一样，
       * 但流是"发出去的那一份"（装置也走它）—— 攒它就不用假设宿主回填了 events。
       */
      reply: (spoken || replyTextOf(outcome.events)).trim(),
      ...(outcome.error ? { error: humanFailure(outcome.error) } : {}),
    });
  } catch (error) {
    send("done", {
      ok: false,
      aborted: controller.signal.aborted,
      actor: MAIN_AGENT,
      cwd,
      error: humanFailure(String((error as Error)?.message ?? error)),
    });
  } finally {
    res.off("close", onClose);
    activeRuns.delete(controller);
    mine.delete(controller);
    if (!mine.size) runsByActor.delete(identity.id);
    built.close();
    if (!res.writableEnded) res.end();
  }
}
