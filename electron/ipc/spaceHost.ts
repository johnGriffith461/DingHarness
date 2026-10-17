import { app, ipcMain } from "electron";

import type { MemberRole } from "../../engine/core/members";
import { normalizeRoles } from "../../engine/core/members";
import { memberView, newPairingCode, redeemPairingCode, removeFromSpace, rolesIn, setMemberRoles } from "../../engine/core/space";
import { createSpaceStore, emptySpaceFile, issueToken, type SpaceFile } from "../../engine/adapters/spaceStore";
import { ledgerOf, rollup } from "../../engine/core/ledger";
import { sumUsage } from "../../shared/cost";
import { desktopSessionStore } from "./sessionStore";

/**
 * **团队空间的桌面入口**（V5-3 3.1/3.2/3.4 的产品面；V5 收尾补）。
 *
 * 与 `ding space`（CLI）和 `/v1/space/*`（服务端）操作的是**同一个账本**
 * （数据目录下的 `space.json`）—— 规矩来自同一份纯函数（`engine/core/space.ts`），
 * 所以三条路上"一码一人 / 不能动主人 / 移除连口令一起作废"一字不差。
 *
 * 桌面这一侧以**主人**身份做事（本机用户就是空间主人），所以：
 *   · 发码、改名册、移除、共享、指定持有人 —— 都做；
 *   · `join` 是"替人入团"（主人兑码拿口令，再私下交给那个人）；
 *     被邀请的人自己兑码走 `POST /v1/space/join`（`ding serve` 那条路）。
 *
 * ⚠️ 口令只在这条 IPC 的**返回里给一次**（与 CLI/服务端同一个口径）：界面显示完
 * 就没了，服务端不提供"再读一次"。
 */

export const SPACE_CHANNEL = {
  state: "space:state",
  invite: "space:invite",
  join: "space:join",
  setRoles: "space:setRoles",
  remove: "space:remove",
  share: "space:share",
  unshare: "space:unshare",
  takeover: "space:takeover",
  usage: "space:usage",
} as const;

/** 名册里的一条（给界面看；**不含口令** —— 那是账，不是名册）。 */
export type SpaceMemberView = {
  id: string;
  kind: "user" | "agent";
  displayName: string;
  roles: string[];
  joinedAt: number;
  /** 是不是主人（界面上不能动他 —— 与纯函数那侧同一条规矩）。 */
  isOwner: boolean;
};

/** 一眼看全的空间现状。 */
export type SpaceStateView = {
  owner: string;
  members: SpaceMemberView[];
  /** 共享出去的会话 id。 */
  shared: string[];
  /** 会话 id → 当前持有人。 */
  holders: Record<string, string>;
  /** 还没用掉的配对码（**码本身要给界面**：主人要在 10 分钟内把它发出去）。 */
  pendingCodes: Array<{ code: string; roles: string[]; expiresAt: number }>;
  /** 账本文件的位置（排错用）。 */
  file: string;
};

/** 一次写入的结果：界面上"成功/为什么没成"都从这一份来。 */
export type SpaceActionResult = { ok: true; note: string; token?: string; code?: string; state: SpaceStateView } | { ok: false; error: string };

const spaceStoreNow = () => createSpaceStore(app.getPath("userData"));

/** 读账（读不出来给空账；**不覆盖**磁盘上那份）。 */
function readSpace(): SpaceFile {
  const got = spaceStoreNow().read();
  if (got.status === "ok") return got.space;
  return emptySpaceFile();
}

/** 组装给界面看的那一份。 */
export function spaceStateView(space: SpaceFile = readSpace()): SpaceStateView {
  return {
    owner: space.roster.owner,
    members: memberView(space.roster).map((m) => ({
      id: m.id,
      kind: m.kind,
      displayName: m.displayName,
      roles: [...m.roles],
      joinedAt: m.joinedAt,
      isOwner: m.id === space.roster.owner,
    })),
    shared: [...space.shared],
    holders: { ...space.holders },
    pendingCodes: space.roster.codes
      .filter((c) => !c.usedBy)
      .map((c) => ({ code: c.code, roles: [...c.roles], expiresAt: c.expiresAt })),
    file: spaceStoreNow().file(),
  };
}

/** 记账并回一份新状态（所有写操作都走它 —— 状态与账本不会各说各话）。 */
function commit(next: SpaceFile, note: string, extra: { token?: string; code?: string } = {}): SpaceActionResult {
  spaceStoreNow().write(next);
  return { ok: true, note, ...extra, state: spaceStateView(next) };
}

/** 成本账本（按成员/按天）—— 读的是**桌面自己的会话库**（与 `ding space usage` 同一条路）。 */
export async function spaceUsage(): Promise<{ turns: number; byMember: Array<{ key: string; turns: number; totalTokens: number | null }>; inputTokens: number; outputTokens: number }> {
  const store = desktopSessionStore();
  const sessions = await store.list();
  const entries = [];
  for (const s of sessions) entries.push(...ledgerOf((await store.load(s.sessionId)).records, s.sessionId, { accountId: s.owner ?? "local" }));
  const usage = sumUsage(entries.map((e) => e.usage));
  return {
    turns: entries.length,
    byMember: rollup(entries, "member").map((r) => ({ key: r.label, turns: r.turns, totalTokens: r.totalTokens })),
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

/** 注册这一族的 IPC。 */
export function registerSpaceIpc(): void {
  ipcMain.handle(SPACE_CHANNEL.state, () => spaceStateView());

  ipcMain.handle(SPACE_CHANNEL.invite, (_event, request: { roles?: string[] } = {}): SpaceActionResult => {
    const space = readSpace();
    const roles = request.roles?.length ? normalizeRoles(request.roles) : ["viewer" as MemberRole];
    const made = newPairingCode(space.roster, { createdBy: space.roster.owner, roles });
    if (!made.ok) return { ok: false, error: made.message };
    return commit({ ...space, roster: { ...space.roster, codes: [...space.roster.codes, made.code] } }, `已发一张码（${made.code.roles.join("/")}）`, { code: made.code.code });
  });

  ipcMain.handle(SPACE_CHANNEL.join, (_event, request: { code?: string; memberId?: string; displayName?: string } = {}): SpaceActionResult => {
    const space = readSpace();
    const got = redeemPairingCode(space.roster, {
      code: String(request.code ?? ""),
      memberId: String(request.memberId ?? ""),
      ...(request.displayName ? { displayName: request.displayName } : {}),
    });
    if (!got.ok) return { ok: false, error: got.message };
    const token = issueToken(space.tokens);
    return commit(
      { ...space, roster: got.roster, tokens: { ...space.tokens, [got.member.id]: token } },
      `${got.member.id} 入团（角色 ${got.member.roles.join("/") || "viewer"}）`,
      { token },
    );
  });

  ipcMain.handle(SPACE_CHANNEL.setRoles, (_event, request: { memberId?: string; roles?: string[] } = {}): SpaceActionResult => {
    const space = readSpace();
    const memberId = String(request.memberId ?? "");
    const roles = normalizeRoles(request.roles ?? []);
    const got = setMemberRoles(space.roster, { by: space.roster.owner, memberId, roles });
    if (!got.ok) return { ok: false, error: got.message };
    return commit({ ...space, roster: got.roster }, `${memberId} 的角色：${roles.join("/") || "（无）"}`);
  });

  ipcMain.handle(SPACE_CHANNEL.remove, (_event, request: { memberId?: string } = {}): SpaceActionResult => {
    const space = readSpace();
    const memberId = String(request.memberId ?? "");
    const got = removeFromSpace(space.roster, { by: space.roster.owner, memberId });
    if (!got.ok) return { ok: false, error: got.message };
    /* 撤权即时生效：口令一并删（不然"移除"只是"以后不行"） */
    const { [memberId]: _gone, ...tokens } = space.tokens;
    return commit({ ...space, roster: got.roster, tokens }, `${memberId} 已移除（口令同时作废）`);
  });

  ipcMain.handle(SPACE_CHANNEL.share, (_event, sessionId: string): SpaceActionResult => {
    const space = readSpace();
    const id = String(sessionId ?? "");
    if (!id) return { ok: false, error: "要共享哪一段会话？" };
    const shared = space.shared.includes(id) ? space.shared : [...space.shared, id];
    return commit({ ...space, shared }, `已共享：${id}`);
  });

  ipcMain.handle(SPACE_CHANNEL.unshare, (_event, sessionId: string): SpaceActionResult => {
    const space = readSpace();
    const id = String(sessionId ?? "");
    const { [id]: _drop, ...holders } = space.holders;
    return commit({ ...space, shared: space.shared.filter((x) => x !== id), holders }, `已取消共享：${id}`);
  });

  ipcMain.handle(SPACE_CHANNEL.takeover, (_event, request: { sessionId?: string; memberId?: string } = {}): SpaceActionResult => {
    const space = readSpace();
    const id = String(request.sessionId ?? "");
    const who = String(request.memberId ?? "");
    if (!space.shared.includes(id)) return { ok: false, error: "这段会话还没共享出去（先共享再接管）" };
    if (!who) return { ok: false, error: "接管人是谁？" };
    if (!rolesIn(space.roster, who)) return { ok: false, error: `${who} 不在这个空间里` };
    return commit({ ...space, holders: { ...space.holders, [id]: who } }, `${id} 的持有人：${who}`);
  });

  ipcMain.handle(SPACE_CHANNEL.usage, () => spaceUsage());
}
