import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { networkInterfaces } from "node:os";

import type { Engine } from "../../engine/index";
import type { SyncRelay } from "../../engine/sync/relay";
import type { SpaceStore } from "../../engine/adapters/spaceStore";
import type { MemberRole } from "../../engine/core/members";
import { canReadSession, handleJoin, handleSpaceRoute, spaceOf } from "./spaceApi";
import { handleRunRoute, handleHookRoute } from "./runApi";
import { handleStreamRoute } from "./streamApi";
import { handleChannelRoute } from "./channelApi";
import type { Recipe } from "../../engine/core/recipes";
import { humanFailure } from "../../shared/errors";
import type { ConfirmMode, SessionSummary } from "../../shared/ipc";
import { PRODUCT_NAME, PRODUCT_VERSION } from "../../shared/product";
import { CwdNotAllowedError } from "../cwd";

/**
 * Agent Server（Phase 17）——把内核暴露成一个本机 HTTP 服务。
 *
 * ## 安全口径（2026-10-16 按审计第 1 单收紧；原文逐条落地）
 *
 * 1. **一律需要 token**（`/healthz` 除外）。原来是「配了 token 才校验」——
 *    于是默认形态（文档推荐的用法）是零鉴权：同机任意进程、任意一个你随手打开的
 *    网页，都能指挥这个能读文件、能跑命令的 agent（drive-by）。
 *    现在：**不给 token 就现场生成一个**，启动时打印出来 —— fail-closed 是默认，
 *    「想省掉口令」不是选项。
 * 2. **校验 `Host` / `Origin` / `Sec-Fetch-Site`**：名字解析被劫持（DNS rebinding）
 *    或跨站页面发起的请求一律拒掉 —— token 之外的第二道门，挡住"浏览器替攻击者
 *    发请求"这一类（它们拿不到 token，但可以让本机 agent 执行副作用之前就出不去）。
 * 3. **token 比较常数时间**（比较 sha256 摘要，不比长度与字符 —— 别让响应时间泄露前缀）。
 * 4. **认证失败限速**：同一来源连续错 8 次锁 30 秒（挡暴力猜口令）。
 * 5. **webhook 必须带 HMAC 签名**（`X-Hub-Signature-256`，密钥来自 `--hook-secret`）：
 *    缺签名 / 签名不对一律 403；**没配密钥时 webhook 整体拒绝**（缺省 fail-closed）。
 * 6. **每一条请求留一行访问日志**（谁、从哪来、要了什么、结果如何）。
 * 7. **客户端断开 → 真中止这一轮**（不留下继续烧钱的孤儿回合）；
 *    关闭服务时销毁在途连接、中止在跑回合。
 *
 * ## 接口（够用就好，不是"什么都暴露"）
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET | `/healthz` | 活着吗（不需要 token —— 探活用；Host/Origin 照样校验） |
 * | GET | `/v1/info` | 这家 agent 是谁、什么能力、当前档位 |
 * | GET | `/v1/sessions` | 会话列表（宿主注入的实现；没注入回 501，不假装空列表） |
 * | GET | `/v1/sessions/:id` | 一段会话的记录 |
 * | POST | `/v1/run` | 跑一轮，**SSE 流式**回事件（`text/event-stream`） |
 * | POST | `/v1/hooks/:name` | webhook 触发器：跑一条预置的提示词（要验签） |
 *
 * ## 与内核的关系
 *
 * 与 CLI / 桌面**同一份装配**（`makeEngine` 由宿主注入）—— 所以"接入外部宿主后
 * 评测集零漂移"是结构上的事，不是接完再验的事。
 */

/** 服务端配置。 */
export type ServerOptions = {
  port: number;
  /** 绑哪个地址。默认 `127.0.0.1`（只回环）。`localhost` 会在 listen 前解析成 `127.0.0.1`。 */
  bind?: string;
  /**
   * 口令。**不给也会生成一个**（见文件头第 1 条）——
   * 绑非回环地址且**没显式给口令**时仍然硬拒（那一步是"别把 agent 送出去"）。
   */
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
  /** webhook 验签密钥（HMAC-SHA256）。不给 = 所有 webhook 一律 403。 */
  hooksSecret?: string;
  /**
   * **成员 token**（V5-2 任务 2.2）：`id` + 各自一把口令。
   *
   * 与 `token`（单口令 = 本机主人）并存 —— **认证机制不变、身份细化**：
   * 每个请求现在知道"是谁在请求"，`GET /v1/sessions` 据此过滤（成员只看得到自己的），
   * 2.3 的 SSE actor 也从这里来。
   *
   * ⚠️ 成员口令**不自动生成**（生成出来的必须打印，而打印多份凭据是坏习惯）；
   * 重复 id / 空口令在**启动时**就拒（fail fast，不等到有人请求）。
   */
  members?: readonly ServerMember[];
  /**
   * **团队空间**（V5-3 3.1）：名册 + 配对码 + 成员口令 + 共享清单的落盘账本。
   *
   * 给了它，`/v1/space/*` 那一族路由才开门（邀请/兑码/成员管理/共享/接管）——
   * 与 `listSessions` 同一个口径：**没接线就 501**。成员口令**当场生效、当场失效**
   * （每一请求都读账本 —— U8-5 的"撤权即时生效"靠的就是不缓存）。
   */
  space?: SpaceStore;
  /** 会话列表（宿主注入的真实实现）。不给 = `/v1/sessions` 回 501。 */
  listSessions?: () => Promise<SessionSummary[]>;
  /**
   * 逐段读会话记录（审计查询用；V5-3 3.3）。
   *
   * ⚠️ 与 `/v1/sessions/:id` 那条**不是同一条路**：那条要建一次引擎（`engine.resume`），
   * 而审计要**扫很多段** —— 每段建一次引擎是荒唐的。所以单给这一格。
   * 不给 = 审计端点回 501（不假装"没有记录"）。
   */
  loadSession?: (sessionId: string) => Promise<{ records: unknown[] }>;
  /** 模板清单（V5-3 3.7 的模板共享要读本体）—— 不给 = 模板共享端点回 501。 */
  listRecipes?: () => Promise<Recipe[]>;
  /**
   * **同步中继**（V5-2 任务 2.1）。
   *
   * 给了它，`/v1/streams/*` 那组端点才开门（create / claim / push / pull / 状态）——
   * 与 `listSessions` 同一个口径：**没接线就回 501**，不假装"这条流是空的"。
   *
   * ⚠️ 中继是**事件总线 + 协调器**，不是数据主人（V5 §4）：本地 SQLite 仍是权威，
   * 这一层只保证"事件按序、恰好一次地送达另一端"；并发接管靠 fencing（epoch 令牌）。
   */
  relay?: SyncRelay;
  log?: (line: string) => void;
};

/** 起服务之后拿到的句柄（端口可能被系统改过 —— 传 0 时就是随机端口）。 */export type StartedAgentServer = {
  server: Server;
  port: number;
  url: string;
  /** **生效的口令**（给的或现场生成的）——本机用要把它告诉用户。 */
  token: string;
  /**
   * 关掉：中止在跑回合、销毁在途连接、停止监听；最迟 3 秒强收
   * （keep-alive / SSE 连接不会拖住关闭）。
   */
  stop: () => Promise<void>;
};

/** 认证失败限速的阈值（同一来源）。 */
const AUTH_FAIL_LIMIT = 8;
const AUTH_LOCK_MS = 30_000;

/**
 * 一个成员的身份（V5-2 2.2）：id + 一把口令。
 *
 * `roles` 暂时不在这里 —— 服务端现在只需要"谁在请求"（owner 过滤）；
 * 角色权限（C2 的两轴判定）在 V5-3 的团队空间接上来时再进这一层（ADR-007 的 follow-up）。
 */
export type ServerMember = {
  id: string;
  token: string;
};

/** 服务端认出来的"现在是谁在请求"。 */
export type RequesterIdentity = {
  id: string;
  /**
   * 空间里的角色（V5-3 3.1：成员口令从空间名册上取得；静态 `--member` 没有角色 = 最保守）。
   * ⚠️ **每一请求现算、不缓存** —— 改角色/移除成员要立刻生效（U8-5）。
   */
  roles?: readonly MemberRole[];
  /**
   * 是不是**本机主人**（单口令那条路）。
   *
   * `true` = 全权（能列全部会话、能指定任意 owner）；`false` = 某个成员
   * （只看得到归自己的会话）。这个区分是 2.2 的核心：**认证机制不变、身份细化**。
   */
  owner: boolean;
};

/** 本机主人那个 id（与 C1 的 owner / C5 的 actor / C4 的归属同一个 id 空间）。 */
const LOCAL_OWNER_ID = "local";

/**
 * 启动前把成员表收窄（坏配置**立刻**拒，别等到有人请求才发现）。
 *
 * @param members 配置里给的成员
 * @returns 干净的成员表
 * @throws 重复 id / 空 id / 空口令 / 口令与主口令相同
 */
function normalizeMembers(members: readonly ServerMember[] | undefined, ownerToken: string): ServerMember[] {
  const out: ServerMember[] = [];
  const ids = new Set<string>();
  for (const member of members ?? []) {
    const id = String(member?.id ?? "").trim();
    const token = String(member?.token ?? "");
    if (!id) throw new Error("成员 token 缺 id：--member <id>:<口令>");
    if (!token.trim()) throw new Error(`成员 ${id} 的口令是空的：--member ${id}:<口令>`);
    if (ids.has(id)) throw new Error(`成员 id 重复：${id}（一个成员一把口令）`);
    if (sameToken(token, ownerToken)) throw new Error(`成员 ${id} 的口令与主口令相同（那样就分不出身份了）`);
    ids.add(id);
    out.push({ id, token });
  }
  return out;
}

/** 请求体上限（别让人用一个超大 body 把内存吃光）。 */
const BODY_LIMIT = 1_000_000;

/**
 * 把 URL 路径里的一段**安全解码**。
 *
 * ⚠️ 2026-10-17（V5-2 2.1 实测逮到）：路径里的百分号序列不合法时
 * （例如客户端按本机代码页编码、或手工拼错了 `%E6%89`），`decodeURIComponent`
 * **会抛 URIError** —— 而它是"请求本身不对"，不该变成 **500 内部错误**。
 * 同一形状原来在 sessions / hooks 两条路上也在（一个坏字节就让服务端答"我的错"）。
 *
 * @param segment 路径里的原始段（percent 编码）
 * @returns 解码后的字符串；解不开给 null（调用方按 400 处理）
 */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export async function startAgentServer(opts: ServerOptions): Promise<StartedAgentServer> {
  /*
   * ⚠️ `localhost` 是**名字**不是地址：把它交给 `listen` 会让 OS 去解析，
   * hosts 文件/DNS 被改到哪就绑到哪。这里先解析成字面量再听（审计 P186）。
   */
  const rawBind = opts.bind?.trim() || "127.0.0.1";
  const bind = rawBind === "localhost" ? "127.0.0.1" : rawBind;
  const isLoopback = bind === "::1" || bind.startsWith("127.");

  /*
   * ⭐ **对外绑定必须显式给 token**：这是"别把 agent 送给整个局域网"那条。
   * 放在这里（起服务之前）而不是每个请求里 —— 配错了就不该起来。
   */
  const explicitToken = opts.token?.trim() || process.env.DH_SERVE_TOKEN?.trim() || "";
  if (!isLoopback && !explicitToken) {
    throw new Error(
      "绑到非回环地址时必须给 --token（或 DH_SERVE_TOKEN）：agent 能读写你的文件、执行命令，" +
        "一个没有认证的公开服务等于把这些交给整个网络。要本机用就别给 --bind（默认只回环）。",
    );
  }
  /* 回环且没显式给口令 → 现场生成一个（fail-closed：没有"零鉴权"这一态） */
  const token = explicitToken || randomBytes(24).toString("base64url");

  const hostNames = allowedHostNamesFor(bind);
  /* 成员表在**启动前**收窄（坏配置立刻拒，别等有人请求才发现） */
  const members = normalizeMembers(opts.members, token);
  const authFailures = new Map<string, { count: number; until: number }>();
  /**
   * 每个人**在跑**的连接（V5-3 3.5：撤销成员要把他的同步通道关掉 —— U8-5）。
   * 键是成员 id；值是那条 SSE / 那一轮的中止句柄。
   */
  const runsByActor = new Map<string, Set<AbortController>>();
  const activeRuns = new Set<AbortController>();
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    handle(req, res, opts, token, members, hostNames, authFailures, activeRuns, runsByActor).catch((error: unknown) => {
      /* 兜底：这一层再漏出去就是"未处理拒绝"（进程会被带走）—— 宁可留一行日志 */
      opts.log?.(`handler 未处理异常：${String((error as Error)?.message ?? error)}`);
      if (!res.headersSent) {
        json(res, 500, { error: humanFailure(String((error as Error)?.message ?? error)) });
      } else {
        res.destroy();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, bind, resolve);
  });
  const port = (server.address() as AddressInfo).port;

  const stop = async (): Promise<void> => {
    for (const controller of activeRuns) controller.abort();
    activeRuns.clear();
    const closed = new Promise<void>((resolve) => {
      /* 已经关过了就别等 —— 否则重复调用要白等下面的 3 秒兜底 */
      if (!server.listening) {
        resolve();
        return;
      }
      server.once("close", () => resolve());
    });
    server.close();
    for (const socket of sockets) socket.destroy();
    await Promise.race([closed, sleep(3_000)]);
  };

  return { server, port, url: `http://${bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind}:${port}`, token, stop };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 允许出现在 `Host` / `Origin` 里的名字（不含端口）。
 *
 * - 回环的三个名字永远在；
 * - 绑具体地址时把那个地址算上；
 * - 绑 `0.0.0.0` / `::`（"全部网卡"）时把**本机所有网卡地址**算上 ——
 *   外部客户端按 IP 访问仍然通，但 `evil.example.com`（DNS rebinding 的那个名字）
 *   不在集合里，直接拒。
 *
 * 这是**名字白名单**，不是"认证"：真假身份仍然由 token 判。它的价值是让
 * "浏览器被别人指挥着打本机 agent"这类请求在进业务之前就出不去。
 */
function allowedHostNamesFor(bind: string): Set<string> {
  const names = new Set<string>(["127.0.0.1", "localhost", "::1"]);
  if (bind !== "0.0.0.0" && bind !== "::") names.add(bind);
  if (bind === "0.0.0.0" || bind === "::") {
    for (const list of Object.values(networkInterfaces())) {
      for (const info of list ?? []) names.add(info.address);
    }
  }
  return names;
}

/** 从 `Host` 头里取主机名（去掉端口；IPv6 去方括号）。 */
function hostNameOf(header: string): string {
  const text = header.trim().toLowerCase();
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    return end > 0 ? text.slice(1, end) : text;
  }
  const colon = text.indexOf(":");
  return colon >= 0 ? text.slice(0, colon) : text;
}

/** `Host` 在不在白名单里（HTTP/1.1 必带 Host；没有就拒）。 */
function hostAllowed(req: IncomingMessage, hostNames: ReadonlySet<string>): boolean {
  const raw = req.headers.host;
  if (!raw) return false;
  return hostNames.has(hostNameOf(raw));
}

/**
 * `Origin` 校验：没有 Origin 的头是**非浏览器客户端**（curl / 我们的 CLI）→ 放行；
 * 有 Origin 就必须落在白名单里。`Origin: null`（沙箱 iframe / file:// 页面）一律拒。
 */
function originAllowed(req: IncomingMessage, hostNames: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === "null") return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return hostNames.has(url.hostname.replace(/^\[|\]$/g, "").toLowerCase());
  } catch {
    return false;
  }
}

/** 跨站发起的请求一律拒（浏览器一定会带这个头；`cross-site` 即"不是本机页面发起的"）。 */
function secFetchAllowed(req: IncomingMessage): boolean {
  const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  return site !== "cross-site";
}

/**
 * 常数时间比较：比较的是**两份 sha256 摘要**。
 *
 * 原来的写法先比长度（`a.length !== b.length` 提前返回）—— 那一步就泄露了口令长度，
 * 而且逐字符 `charCodeAt` 比较在 V8 里不保证不短路（审计 P180）。
 */
function sameToken(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * 认出"现在是谁"（V5-2 2.2）。
 *
 * ⚠️ **候选全比一遍再决定**（不提前 return）：提前退出会让"匹配上的是第几个成员"
 * 从耗时里漏出去。与 `sameToken` 的常数时间比较是同一条纪律的两半。
 *
 * @param req 请求
 * @param ownerToken 主口令（单口令那条路 = 本机主人）
 * @param members 成员表（可能为空）
 * @returns 身份；凭据不对/没带给 null（调用方按 401 + 限速处理）
 */
function identify(
  req: IncomingMessage,
  ownerToken: string,
  members: readonly ServerMember[],
  spaceMembers: ReadonlyArray<{ id: string; token: string; roles: readonly MemberRole[] }> = [],
): RequesterIdentity | null {
  const header = req.headers.authorization ?? "";
  const got = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!got) return null;
  let identity: RequesterIdentity | null = null;
  /* 主口令优先（它是主人；成员的 id 万一也叫 local，主人身份不该被成员抢走） */
  if (sameToken(got, ownerToken)) identity = { id: LOCAL_OWNER_ID, owner: true, roles: ["owner"] };
  for (const member of members) {
    if (sameToken(got, member.token) && !identity) identity = { id: member.id, owner: false };
  }
  for (const member of spaceMembers) {
    if (sameToken(got, member.token) && !identity) identity = { id: member.id, owner: false, roles: member.roles };
  }
  return identity;
}

/** 空间成员的口令表（每一请求现读 —— 见 `RequesterIdentity.roles` 的说明）。 */
function spaceMembersOf(space: SpaceStore | undefined): Array<{ id: string; token: string; roles: readonly MemberRole[] }> {
  if (!space) return [];
  const got = space.read();
  if (got.status !== "ok") return [];
  const { roster, tokens } = got.space;
  return Object.entries(tokens)
    .map(([id, token]) => ({
      id,
      token,
      roles: roster.members.find((m) => m.id === id)?.roles ?? [],
    }))
    .filter((x) => Boolean(x.token));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return; // 头已经发出去就不许再发（那会抛 ERR_HTTP_HEADERS_SENT）
  const text = JSON.stringify(body, null, 2);
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    res.end(text);
  } catch {
    /* 连接已经没了（客户端提前断开）：这条响应发不出去就是发不出去，别升级成进程级异常 */
    res.destroy();
  }
}

/**
 * 读请求体（有上限）。
 *
 * ⚠️ 收的是**字节**，不是逐块 `toString("utf8")` 拼字符串 ——
 * 一个 UTF-8 汉字 3 个字节，正好落在两个 chunk 之间时，逐块解码会把两半各自
 * 变成 U+FFFD（中文提示词变乱码，且请求还"成功"了）。字节收齐再解码（审计 P179）。
 * 签名校验也必须要原始字节（HMAC 是对字节算的）。
 */
function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`请求体超过上限 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** webhook 签名：GitHub 风格的 `X-Hub-Signature-256: sha256=<hex>`（HMAC-SHA256，对**原始字节**）。 */
function signatureOk(raw: Buffer, header: unknown, secret: string): boolean {
  const given = String(header ?? "").trim().toLowerCase();
  const hex = given.startsWith("sha256=") ? given.slice(7) : "";
  if (hex.length !== 64 || !/^[0-9a-f]+$/.test(hex)) return false;
  const expect = createHmac("sha256", secret).update(raw).digest("hex");
  return sameToken(hex, expect);
}

/** `/v1/run` 的 sessionId 白名单（它会被写进会话库；杂字符没有存在的理由）。 */
const SESSION_ID_OK = /^[A-Za-z0-9._:-]{1,200}$/;

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  token: string,
  members: readonly ServerMember[],
  hostNames: ReadonlySet<string>,
  authFailures: Map<string, { count: number; until: number }>,
  activeRuns: Set<AbortController>,
  runsByActor: Map<string, Set<AbortController>>,
): Promise<void> {
  const ip = req.socket.remoteAddress ?? "?";
  const startedAt = Date.now();
  /* 连接被掐断时的写入错误：吞掉，别把它升级成进程级异常（未处理 'error' 会带走进程） */
  res.on("error", () => undefined);
  /* 访问日志：每一条请求都留一行（含被拒的），挂在 close 上保证"结束必记" */
  let note = "";
  res.once("close", () => {
    opts.log?.(
      `${ip} ${req.method ?? "?"} ${req.url ?? "?"} → ${res.statusCode}${note ? `（${note}）` : ""} ${Date.now() - startedAt}ms`,
    );
  });

  /*
   * ⚠️ URL 解析必须在 try 里：Node 的 HTTP/1.1 解析器接受**代理形式**的请求目标
   * （`GET http://a:99999/ HTTP/1.1`），而端口越界会让 `new URL` 抛 TypeError。
   * 原来这一句在鉴权之前、也在 try 之外 —— 一个**未鉴权**的请求就能把服务进程带走
   * （未处理拒绝 → 进程退出，审计 P169/P170）。
   */
  let path: string;
  try {
    path = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    note = "请求目标不是合法 URL";
    json(res, 400, { error: "请求目标不是合法 URL" });
    return;
  }

  /* Host / Origin / Sec-Fetch 三道都在这（探活也不例外 —— "拒"就是拒） */
  if (!hostAllowed(req, hostNames)) {
    note = `Host 不在白名单（${String(req.headers.host ?? "（没带）")}）`;
    json(res, 400, { error: `Host 不在允许列表里：${String(req.headers.host ?? "（没带）")}` });
    return;
  }
  if (!originAllowed(req, hostNames)) {
    note = `Origin 不在白名单（${String(req.headers.origin ?? "")}）`;
    json(res, 403, { error: `Origin 不在允许列表里：${String(req.headers.origin ?? "")}` });
    return;
  }
  if (!secFetchAllowed(req)) {
    note = "跨站发起（Sec-Fetch-Site: cross-site）";
    json(res, 403, { error: "跨站请求一律拒绝" });
    return;
  }

  /* 探活不需要 token（否则负载均衡器/监控用不了） */
  if (path === "/healthz") {
    json(res, 200, { ok: true });
    return;
  }

  /* 认证失败限速：错够 8 次锁 30 秒（暴力猜口令的代价） */
  const lock = authFailures.get(ip);
  if (lock && lock.until > Date.now()) {
    note = "认证失败已锁定";
    json(res, 429, { error: "认证失败次数过多，稍后再试" });
    return;
  }
  /** 记一次认证失败（猜口令与**猜配对码**同一条限速）。 */
  const countAuthFailure = (): void => {
    const entry = authFailures.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= AUTH_FAIL_LIMIT) {
      entry.count = 0;
      entry.until = Date.now() + AUTH_LOCK_MS;
    }
    authFailures.set(ip, entry);
  };
  /*
   * ⭐ `/v1/space/join` 的**唯一例外**（V5-3 3.1）：要被邀请的人还没有口令
   * （口令正是这一次要发给他的），那条路的凭据是**配对码本身**（限时 + 一次性）。
   * 兑错码同样记一次认证失败 —— 猜码与猜口令一条限速。
   */
  if (path === "/v1/space/join") {
    if (!opts.space) {
      note = "space 未接线";
      json(res, 501, { error: "这个服务没有接团队空间（宿主没把 space 账本交给它）" });
      return;
    }
    if (await handleJoin(req, res, { store: opts.space, note: (t) => (note = t), countAuthFailure })) return;
  }

  const identity = identify(req, token, members, spaceMembersOf(opts.space));
  if (!identity) {
    countAuthFailure();
    note = "凭据不对/没带";
    json(res, 401, { error: "需要 Authorization: Bearer <token>" });
    return;
  }
  authFailures.delete(ip);

  try {
    if (path === "/v1/info" && req.method === "GET") {
      note = "info";
      json(res, 200, {
        /* 身份（V5-2 2.2）：调用方现在知道"服务端认为我是谁" */
        you: { id: identity.id, owner: identity.owner },
        name: PRODUCT_NAME,
        version: PRODUCT_VERSION,
        provider: opts.provider,
        ...(opts.model ? { model: opts.model } : {}),
        /** 当前闸门档位（外部宿主该知道"写与执行会不会被拦"）。 */
        mode: opts.mode,
        ...(opts.mode === "按需确认"
          ? { modeNote: "服务态没有审批通道：需要确认的工具会被拦下（不会执行），如实上报为失败" }
          : {}),
        cwd: opts.cwd,
        hooks: Object.keys(opts.hooks ?? {}),
      });
      return;
    }

    /* ── 团队空间与审计（V5-3 3.1/3.2/3.3/3.5）：整族路由在 `./spaceApi.ts` ── */
    if (path.startsWith("/v1/space") || path === "/v1/audit" || path === "/v1/usage") {
      if (!opts.space) {
        note = "space 未接线";
        json(res, 501, { error: "这个服务没有接团队空间（宿主没把 space 账本交给它）" });
        return;
      }
      const handled = await handleSpaceRoute(path, req, res, {
        store: opts.space,
        /* 审计（3.3）扫会话要这两个 —— 与 `/v1/sessions` 同一个来源 */
        ...(opts.listSessions ? { listSessions: opts.listSessions } : {}),
        ...(opts.loadSession ? { loadSession: opts.loadSession } : {}),
        ...(opts.listRecipes ? { listRecipes: opts.listRecipes } : {}),
        identity,
        note: (t) => (note = t),
        abortRunsOf: (memberId) => {
          const set = runsByActor.get(memberId);
          if (!set) return 0;
          let n = 0;
          for (const controller of set) {
            controller.abort();
            n += 1;
          }
          runsByActor.delete(memberId);
          return n;
        },
      });
      if (handled) return;
    }

    if (path === "/v1/sessions" && req.method === "GET") {
      /*
       * ⚠️ 宿主没把会话库交给服务层时回 **501**，不是"假装一个空列表"：
       * 空数组是在说"一台机器上一个会话都没有"，那是**编的**（审计 P183）。
       */
      if (!opts.listSessions) {
        note = "sessions 未接线";
        json(res, 501, { error: "这个服务没有接会话库，列不了会话（宿主没把 store 交给它）" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const wanted = (url.searchParams.get("owner") ?? "").trim();
      /*
       * ⭐ **归属过滤**（V5-2 2.2 的验收那条）：
       *   · 本机主人（单口令）：不给 `?owner=` = 列全部；给了就只列那个 owner 的；
       *   · 成员：**默认只列归自己的**（不给参数也一样）；指定别人的 owner → **403**
       *     （不是"悄悄过滤成空的" —— 那会让人以为对方没有会话）。
       * 归属缺省按兼容口径 `local`（旧会话补列之前没有这一格）。
       */
      if (!identity.owner && wanted && wanted !== identity.id) {
        note = `成员 ${identity.id} 想看 ${wanted} 的会话`;
        json(res, 403, {
          error: `只能查归你的会话（你是 ${identity.id}）；共享给你的那些不用带 ?owner=`,
        });
        return;
      }
      const all = await opts.listSessions();
      /*
       * 可见集（V5-3 3.2/U8-2）：主人 = 全部；成员 = **自己的 + 共享出去的**。
       * 共享之后成员看得见主人的那段会话（内容与主人一致 —— 同一个本地库同一批记录）。
       */
      const space = opts.space ? spaceOf(opts.space) : null;
      const emptySpace = space ?? { roster: { owner: identity.id, members: [], codes: [] }, tokens: {}, shared: [], sharedRecipes: [], holders: {}, rooms: {} };
      const sessions = identity.owner
        ? (wanted ? all.filter((s) => (s.owner ?? LOCAL_OWNER_ID) === wanted) : all)
        : all.filter((s) => canReadSession(emptySpace, identity, s.sessionId, s.owner));
      note = `${sessions.length} 段会话${identity.owner && wanted ? `（owner=${wanted}）` : !identity.owner ? `（${identity.id} 的 + 共享的）` : ""}`;
      json(res, 200, { sessions, you: { id: identity.id, owner: identity.owner } });
      return;
    }

    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch && req.method === "GET") {
      const id = safeDecode(sessionMatch[1]!);
      if (id === null) {
        note = "sessionId 解码不了";
        json(res, 400, { error: "sessionId 的百分号编码不合法（解码失败）" });
        return;
      }
      if (!SESSION_ID_OK.test(id)) {
        note = "sessionId 形状不对";
        json(res, 400, { error: "sessionId 形状不对" });
        return;
      }
      const built = await opts.makeEngine(opts.cwd);
      try {
        const resumed = await built.engine.resume(id);
        note = `会话 ${id}：${resumed.turns.length} 轮`;
        json(res, 200, { sessionId: id, turns: resumed.turns.length, pending: resumed.pending.length });
      } finally {
        built.close();
      }
      return;
    }

    /* ── 同步中继（V5-2 2.1）：整族在 `./streamApi.ts` ── */
    if (await handleStreamRoute(path, req, res, { relay: opts.relay, json, safeDecode, readBody, note: (t) => (note = t) })) return;


    /* ── 跑一轮的两条入口（V5-2 2.3 / V5-3 3.2 的写侧规则）：在 `./runApi.ts` ── */
    const runCtx = {
      opts,
      identity,
      activeRuns,
      runsByActor,
      json,
      readBody,
      safeDecode,
      signatureOk,
      note: (t: string) => (note = t),
    };
    if (await handleRunRoute(path, req, res, runCtx)) return;
    if (await handleHookRoute(path, req, res, runCtx)) return;
    /* 多渠道触发（V5-3 3.6）：外面的一条消息 → 事件入流 → 回执（done 帧的 reply） */
    if (await handleChannelRoute(path, req, res, runCtx)) return;

    note = "没有这个路径";
    json(res, 404, { error: `没有这个路径：${req.method} ${path}` });
  } catch (error) {
    if (error instanceof CwdNotAllowedError) {
      note = "cwd 不在授权范围";
      json(res, 400, { error: error.message });
      return;
    }
    /*
     * ⚠️ 头已经发出去时**不能再发一次 JSON**（那一步抛 ERR_HTTP_HEADERS_SENT，
     * 而它又发生在 catch 里 → 未处理拒绝 → 进程退出，审计 P169）。
     * 这时候唯一正确的收场是掐掉这条连接。
     */
    if (res.headersSent) {
      note = `已开流后出错：${String((error as Error)?.message ?? error).slice(0, 120)}`;
      res.destroy();
      return;
    }
    note = "内部错误";
    json(res, 500, { error: humanFailure(String((error as Error)?.message ?? error)) });
  }
}
