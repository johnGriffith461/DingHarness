import type { IncomingMessage, ServerResponse } from "node:http";

import { normalizeRoles, type MemberRole } from "../../engine/core/members";
import {
  memberView,
  newPairingCode,
  redeemPairingCode,
  removeFromSpace,
  rolesIn,
  setMemberRoles,
  type SpaceMember,
} from "../../engine/core/space";
import { emptySpaceFile, issueToken, type SpaceFile, type SpaceStore } from "../../engine/adapters/spaceStore";
import { auditOf, auditQuery, auditSummary, type AuditEntry } from "../../engine/core/audit";
import { ledgerOf, rollup, type LedgerEntry } from "../../engine/core/ledger";
import { sumUsage } from "../../shared/cost";
import type { Recipe } from "../../engine/core/recipes";
import type { RequesterIdentity } from "./agentServer";

/**
 * **团队空间的 HTTP 面**（V5-3 任务 3.1 / 3.2 / 3.5）。
 *
 * 从 `agentServer.ts` 拆出来（那个文件贴着 900 行上限）：这一族路由自成一块
 * —— 名册三件（邀请/兑码/成员管理）、共享两件（共享/取消）、接管一件。
 *
 * ## 一个刻意的例外：`/v1/space/join` **不要 Bearer 口令**
 *
 * 要被邀请的人**还没有**口令（口令正是这一次要发给他的）。那条路的凭据就是
 * **配对码本身**：限时（10 分钟）+ 一次性（一码一人）。它挂在服务端的主鉴权之外，
 * 但**兑错码同样进限速表**（猜码的代价与猜口令一样）。
 *
 * 其余路由都要身份：主人（主口令）或空间成员；能管成员的只有 owner/admin 角色。
 */

/** 身份 + 空间账（`agentServer` 每一请求现算 —— 3.5 的"即时生效"就靠这个）。 */
export type SpaceCtx = {
  store: SpaceStore;
  /** 会话清单 + 逐段读取（审计查询要扫日志）—— 宿主注入（没有就是 501）。 */
  listSessions?: () => Promise<Array<{ sessionId: string; owner?: string }>>;
  loadSession?: (sessionId: string) => Promise<{ records: unknown[] }>;
  /** 模板清单（V5-3 3.7：共享模板要先把本体读出来）—— 宿主注入。 */
  listRecipes?: () => Promise<Recipe[]>;
  /** 当前身份（已由主鉴权认出来）。 */
  identity: RequesterIdentity & { roles?: readonly MemberRole[] };
  /** 在跑的那条连接的中止句柄（撤销成员时要把他的通道关掉 —— U8-5）。 */
  abortRunsOf?: (memberId: string) => number;
  note: (text: string) => void;
};

/** 读账；没有就当场给一份空账（**不落盘** —— 落盘发生在第一次写时）。 */
export function spaceOf(store: SpaceStore): SpaceFile {
  const got = store.read();
  return got.status === "ok" ? got.space : emptySpaceFile();
}

/** 现在是谁：主人（主口令）或名册里的成员；都不是 → null。 */
export function spaceRolesOf(space: SpaceFile, identity: RequesterIdentity): MemberRole[] | null {
  if (identity.owner) return ["owner"];
  return rolesIn(space.roster, identity.id);
}

/** 一个成员能不能管名册（角色并集，见 `members.ts` 的 `CAPABILITIES`）。 */
function canManage(roles: readonly MemberRole[] | null): boolean {
  return Boolean(roles && (roles.includes("owner") || roles.includes("admin")));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body, null, 2);
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    res.end(text);
  } catch {
    res.destroy();
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * **不要鉴权**的那一条：兑配对码（见文件头）。
 *
 * @returns 处理了就给 true（响应已写）
 */
export async function handleJoin(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { store: SpaceStore; note: (t: string) => void; countAuthFailure?: () => void },
): Promise<boolean> {
  if (req.method !== "POST") {
    json(res, 405, { error: "兑配对码用 POST /v1/space/join" });
    return true;
  }
  const body = await readJson(req);
  if (!body) {
    ctx.note("join：body 不是 JSON");
    json(res, 400, { error: "body 必须是 JSON：{code, memberId, displayName?}" });
    return true;
  }
  const space = spaceOf(ctx.store);
  const got = redeemPairingCode(space.roster, {
    code: String(body.code ?? ""),
    memberId: String(body.memberId ?? ""),
    ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
  });
  if (!got.ok) {
    /* 兑错码与猜口令**同一条限速**：猜码也是攻击 */
    ctx.countAuthFailure?.();
    ctx.note(`join 失败：${got.reason}`);
    json(res, got.reason === "unknown" ? 404 : 409, { error: got.message, reason: got.reason });
    return true;
  }

  const token = issueToken(space.tokens);
  const next: SpaceFile = {
    ...space,
    roster: got.roster,
    tokens: { ...space.tokens, [got.member.id]: token },
  };
  ctx.store.write(next);
  ctx.note(`join：${got.member.id} 入空间（角色 ${got.member.roles.join("/") || "无"}）`);
  /*
   * ⚠️ 口令**只在这一条响应里给一次**（服务端不提供"再读一次口令"的接口）：
   * 丢了就重新邀请 —— 口令可读回 = 任何拿到名册的人都成了任何人。
   */
  json(res, 200, { token, member: got.member, note: "这把口令只显示这一次，请收好（丢了就让管理员重新邀请）" });
  return true;
}

/**
 * 其余空间路由（**都已通过主鉴权**）。
 *
 * @returns 处理了就给 true
 */
export async function handleSpaceRoute(
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SpaceCtx,
): Promise<boolean> {
  /* 审计查询（V5-3 3.3）也归这一族：它查的是"空间里谁做过什么" */
  if (path === "/v1/audit" && req.method === "GET") {
    const space0 = spaceOf(ctx.store);
    const roles0 = spaceRolesOf(space0, ctx.identity);
    if (!ctx.identity.owner && !roles0) {
      ctx.note(`非成员查审计：${ctx.identity.id}`);
      json(res, 403, { error: `${ctx.identity.id} 不在这个空间里` });
      return true;
    }
    if (!ctx.identity.owner && !canManage(roles0)) {
      ctx.note(`审计被拒（${ctx.identity.id} 不是 owner/admin）`);
      json(res, 403, { error: "审计只有所有者/管理员能查" });
      return true;
    }
    if (!ctx.listSessions || !ctx.loadSession) {
      ctx.note("审计未接线");
      json(res, 501, { error: "这个服务没有接审计需要的会话库（宿主没给 listSessions/loadSession）" });
      return true;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const member = (url.searchParams.get("member") ?? "").trim();
    const sinceRaw = url.searchParams.get("since");
    const limitRaw = url.searchParams.get("limit");
    const sessions = await ctx.listSessions();
    const entries: AuditEntry[] = [];
    for (const s of sessions) {
      const got = await ctx.loadSession(s.sessionId);
      entries.push(...auditOf(s.sessionId, got.records as never[]));
    }
    const hits = auditQuery(entries, {
      ...(member ? { member } : {}),
      ...(sinceRaw === null ? {} : { since: Number(sinceRaw) }),
      ...(limitRaw === null ? {} : { limit: Number(limitRaw) }),
    });
    ctx.note(`审计：${hits.length} 条（共 ${entries.length} 条在册）`);
    json(res, 200, { entries: hits, summary: auditSummary(entries) });
    return true;
  }

  /* 成本账本（V5-3 3.4）：按成员/按天/合计 —— 同样的 owner/admin 门 */
  if (path === "/v1/usage" && req.method === "GET") {
    const spaceU = spaceOf(ctx.store);
    const rolesU = spaceRolesOf(spaceU, ctx.identity);
    if (!ctx.identity.owner && !canManage(rolesU)) {
      ctx.note(`账本被拒（${ctx.identity.id} 不是 owner/admin）`);
      json(res, 403, { error: "成本账本只有所有者/管理员能查" });
      return true;
    }
    if (!ctx.listSessions || !ctx.loadSession) {
      ctx.note("账本未接线");
      json(res, 501, { error: "这个服务没有接账本需要的会话库（宿主没给 listSessions/loadSession）" });
      return true;
    }
    const sessions = await ctx.listSessions();
    const entries: LedgerEntry[] = [];
    for (const s of sessions) {
      const got = await ctx.loadSession(s.sessionId);
      /* 三层身份：account = 这段会话的归属（空间/账目）；end_user 由渠道那侧注入（这里没有） */
      entries.push(...ledgerOf(got.records as never[], s.sessionId, { accountId: s.owner ?? "local" }));
    }
    const byMember = rollup(entries, "member");
    const byDay = rollup(entries, "day");
    const byAccount = rollup(entries, "account");
    const all = rollup(entries, "session");
    const total = {
      turns: entries.length,
      usage: sumUsage(entries.map((e) => e.usage)) ?? null,
    };
    ctx.note(`账本：${entries.length} 轮 / ${byMember.length} 名成员`);
    json(res, 200, { total, byMember, byDay, byAccount, bySession: all });
    return true;
  }

  if (!path.startsWith("/v1/space")) return false;
  const space = spaceOf(ctx.store);
  const roles = spaceRolesOf(space, ctx.identity);
  const me = ctx.identity.id;

  /* 门外的人（既不是主人也不在名册里）：一律 403，连"空间存不存在"都不说 */
  if (!ctx.identity.owner && roles === null) {
    ctx.note(`非成员访问空间：${me}`);
    json(res, 403, { error: `${me} 不在这个空间里` });
    return true;
  }

  if (path === "/v1/space" && req.method === "GET") {
    ctx.note(`空间：${space.roster.members.length} 名成员`);
    json(res, 200, {
      you: { id: me, owner: ctx.identity.owner, roles: roles ?? [] },
      owner: space.roster.owner,
      members: memberView(space.roster),
      shared: space.shared,
      holders: space.holders,
    });
    return true;
  }

  if (path === "/v1/space/invite" && req.method === "POST") {
    const body = (await readJson(req)) ?? {};
    const made = newPairingCode(space.roster, {
      createdBy: me,
      ...(body.roles === undefined ? {} : { roles: normalizeRoles(body.roles) }),
    });
    if (!made.ok) {
      ctx.note("invite 被拒");
      json(res, 403, { error: made.message });
      return true;
    }
    ctx.store.write({ ...space, roster: { ...space.roster, codes: [...space.roster.codes, made.code] } });
    ctx.note(`invite：发了一张码（角色 ${made.code.roles.join("/")}）`);
    /* 码本身在响应里给一次；名册里存着的是它（还没用过） */
    json(res, 200, { code: made.code.code, roles: made.code.roles, expiresAt: made.code.expiresAt });
    return true;
  }

  if (path === "/v1/space/members" && req.method === "GET") {
    json(res, 200, { members: memberView(space.roster) });
    return true;
  }

  const roleMatch = /^\/v1\/space\/members\/([^/]+)\/roles$/.exec(path);
  if (roleMatch && req.method === "POST") {
    const memberId = decodeURIComponent(roleMatch[1]!);
    const body = (await readJson(req)) ?? {};
    const got = setMemberRoles(space.roster, { by: me, memberId, roles: normalizeRoles(body.roles) });
    if (!got.ok) {
      ctx.note(`改角色被拒：${got.reason}`);
      json(res, got.reason === "no-member" ? 404 : 403, { error: got.message });
      return true;
    }
    ctx.store.write({ ...space, roster: got.roster });
    ctx.note(`角色：${memberId} → ${normalizeRoles(body.roles).join("/") || "viewer"}`);
    json(res, 200, { ok: true, member: got.roster.members.find((m) => m.id === memberId) });
    return true;
  }

  const memberMatch = /^\/v1\/space\/members\/([^/]+)$/.exec(path);
  if (memberMatch && req.method === "DELETE") {
    const memberId = decodeURIComponent(memberMatch[1]!);
    const got = removeFromSpace(space.roster, { by: me, memberId });
    if (!got.ok) {
      ctx.note(`移除被拒：${got.reason}`);
      json(res, got.reason === "no-member" ? 404 : 403, { error: got.message });
      return true;
    }
    /*
     * **撤销即时生效**（V5-3 3.5，U8-5）：口令当场从账上删掉（下一请求就 401），
     * 他的**在跑通道也一并中止**（SSE / 跑着的回合）—— "撤权"不能只是"以后不行"。
     */
    const { [memberId]: _revoked, ...restTokens } = space.tokens;
    const aborted = ctx.abortRunsOf?.(memberId) ?? 0;
    ctx.store.write({ ...space, roster: got.roster, tokens: restTokens });
    ctx.note(`移除：${memberId}（中止 ${aborted} 条在跑通道）`);
    json(res, 200, { ok: true, aborted });
    return true;
  }

  /* ── 3.7：模板共享（模板本体在宿主的 recipes.json；这里只记"哪些共享了"） ── */

  if (path === "/v1/space/recipes" && req.method === "GET") {
    if (!ctx.listRecipes) {
      ctx.note("模板共享未接线");
      json(res, 501, { error: "这个服务没有接模板库（宿主没给 listRecipes）" });
      return true;
    }
    const all = await ctx.listRecipes();
    /* 共享出去的那些，**给完整 JSON**（别人要能照着装 —— 与 `ding recipe export` 同一份形状） */
    const shared = all.filter((r) => space.sharedRecipes.includes(r.id));
    ctx.note(`共享模板：${shared.length} 份`);
    json(res, 200, { recipes: shared, shared: space.sharedRecipes });
    return true;
  }

  const recipeMatch = /^\/v1\/space\/recipes\/([^/]+)\/share$/.exec(path);
  if (recipeMatch) {
    if (!canManage(roles) && me !== space.roster.owner) {
      ctx.note("模板共享被拒（不是主人/管理员）");
      json(res, 403, { error: "只有空间主人/管理员能把模板共享出去" });
      return true;
    }
    const recipeId = decodeURIComponent(recipeMatch[1]!);
    if (req.method === "POST") {
      if (!ctx.listRecipes) {
        json(res, 501, { error: "这个服务没有接模板库（宿主没给 listRecipes）" });
        return true;
      }
      const all = await ctx.listRecipes();
      if (!all.some((r) => r.id === recipeId)) {
        ctx.note(`没有这份模板：${recipeId}`);
        json(res, 404, { error: `没有这份模板：${recipeId}` });
        return true;
      }
      const sharedRecipes = space.sharedRecipes.includes(recipeId) ? space.sharedRecipes : [...space.sharedRecipes, recipeId];
      ctx.store.write({ ...space, sharedRecipes });
      ctx.note(`共享模板：${recipeId}`);
      json(res, 200, { ok: true, sharedRecipes });
      return true;
    }
    if (req.method === "DELETE") {
      const sharedRecipes = space.sharedRecipes.filter((x) => x !== recipeId);
      ctx.store.write({ ...space, sharedRecipes });
      ctx.note(`取消共享模板：${recipeId}`);
      json(res, 200, { ok: true, sharedRecipes });
      return true;
    }
  }

  /* ── 3.2：共享 / 接管 ─────────────────────────────────────────── */

  const shareMatch = /^\/v1\/space\/share\/([^/]+)$/.exec(path);
  if (shareMatch) {
    const sessionId = decodeURIComponent(shareMatch[1]!);
    if (req.method === "POST") {
      /* 共享是**会话拥有者（或能管成员的人）**的动作：把这段会话放进空间的可见集 */
      if (!canManage(roles) && me !== space.roster.owner) {
        ctx.note("共享被拒（不是空间主人）");
        json(res, 403, { error: "只有空间主人/管理员能把会话共享出去" });
        return true;
      }
      const shared = space.shared.includes(sessionId) ? space.shared : [...space.shared, sessionId];
      ctx.store.write({ ...space, shared });
      ctx.note(`共享：${sessionId}`);
      json(res, 200, { ok: true, shared });
      return true;
    }
    if (req.method === "DELETE") {
      if (!canManage(roles) && me !== space.roster.owner) {
        json(res, 403, { error: "只有空间主人/管理员能取消共享" });
        return true;
      }
      const shared = space.shared.filter((x) => x !== sessionId);
      const { [sessionId]: _dropHolder, ...holders } = space.holders;
      ctx.store.write({ ...space, shared, holders });
      ctx.note(`取消共享：${sessionId}`);
      json(res, 200, { ok: true, shared });
      return true;
    }
  }

  const takeMatch = /^\/v1\/space\/takeover\/([^/]+)$/.exec(path);
  if (takeMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(takeMatch[1]!);
    if (!space.shared.includes(sessionId)) {
      ctx.note(`接管被拒（未共享）：${sessionId}`);
      json(res, 409, { error: "这段会话没有共享出去，接管不了（先让主人共享）" });
      return true;
    }
    const holder = me;
    ctx.store.write({ ...space, holders: { ...space.holders, [sessionId]: holder } });
    ctx.note(`接管：${sessionId} → ${holder}`);
    /* 返回接管人（写侧据此放行：持有人能往这段会话里写） */
    json(res, 200, { ok: true, sessionId, holder });
    return true;
  }

  ctx.note(`空间路由不认识：${req.method} ${path}`);
  json(res, 404, {
    error: `没有这个空间路径：${req.method} ${path}（可用：GET /v1/space、POST invite/join、GET members、POST members/:id/roles、DELETE members/:id、POST/DELETE share/:sessionId、POST takeover/:sessionId）`,
  });
  return true;
}

/**
 * 本地库里"这段会话归谁"的一次查询结果（**三态**，两个门都要它）：
 *
 * · `{ owner }` —— 查到了，归 owner；
 * · `null` —— **查过了、没有这一段**（写侧：这一次写入就是它在创建，归属是发起人）；
 * · `undefined` —— **没查**（宿主没接 `listSessions`）：什么都不能假设，按最保守判。
 *
 * ⚠️ 三态而不是"owner ?? 'local'"（2026-10-17 实测逮到，U8 验收脚本）：
 * 两态时"查不到"与"没查"长得一样，于是**成员建自己的新会话**也被当成
 * "往 local 的会话里写"一并拒掉 —— 成员在服务端根本开不了新会话。
 */
export type SessionLookup = { owner: string } | null | undefined;

/**
 * **成员能不能写这段会话**（3.2 的写侧规则；`runStreaming` 之前的检查用它）。
 *
 * 规则（U8-3"接管后审批不穿帮"的地基）：
 *   · 主人（主口令）：任何会话都能写；
 *   · 成员：自己的能写；**本地还没有的那段**能写（那是他在建它，归属在这一步定下来）；
 *     共享出来且他是当前持有人的能写；其余 403。
 *
 * @param space 空间账
 * @param identity 身份
 * @param sessionId 会话
 * @param lookup 这段会话在本地库里的归属（`SessionLookup` 的三态）
 * @returns 能不能写
 */
export function canWriteSession(
  space: SpaceFile,
  identity: RequesterIdentity,
  sessionId: string,
  lookup: SessionLookup,
): boolean {
  if (identity.owner) return true;
  if (lookup && lookup.owner === identity.id) return true;
  /* 查过了、库里没有：**这是它在创建**（归属 = 发起人）。没查过（undefined）不算数 —— 不猜。 */
  if (lookup === null) return true;
  return space.shared.includes(sessionId) && space.holders[sessionId] === identity.id;
}

/** 成员能不能**读**这段会话（U8-2：共享出来的会话成员读得到，内容与主人一致）。 */
export function canReadSession(
  space: SpaceFile,
  identity: RequesterIdentity,
  sessionId: string,
  lookup: SessionLookup,
): boolean {
  if (identity.owner) return true;
  if (lookup && lookup.owner === identity.id) return true;
  /*
   * `null`（库里没有）与"别人的"一样：不给自己之外的任何东西开门 ——
   * 有没有内容由共享清单说了算（没内容可读也不算漏）。
   * `undefined`（没查）保持老口径：只有共享这一条路。
   */
  return space.shared.includes(sessionId);
}

/** 成员视图里的名册（`GET /v1/space` 的 members 就是它 —— 不含口令）。 */
export type SpaceMemberView = SpaceMember[];

/** 空账的便捷导出（`ding serve` 起服务时判"要不要建空间"用）。 */
export const EMPTY_SPACE = emptySpaceFile;
