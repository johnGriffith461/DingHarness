import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSpaceStore } from "@engine/adapters/spaceStore";
import { rolesIn } from "@engine/core/space";
import { SPACE_CHANNEL, spaceStateView, spaceUsage } from "../electron/ipc/spaceHost";

/**
 * **桌面这一侧的团队空间**（V5-3 的产品面；V5 收尾）。
 *
 * 与 CLI / 服务端那两条路操作的是**同一个账本**（数据目录下的 `space.json`），
 * 规矩来自同一份纯函数。这一组盯着的是"桌面这条路真的改了账本"：
 * 发码进账本、入团后名册与口令都对、**口令只给一次**（返回里有、状态里没有）、
 * 改角色/移除（主人动不了、口令一并没）、共享与持有人（未共享先拒）、
 * 账本读的是真会话库。
 *
 * 用 mock 的 electron（`app.getPath` 指向临时目录）—— 与 `snapshotStore.test.ts` 同一套做法。
 */

const env = { userData: "" };
/** 每个用例换一个数据目录；宿主是**懒读路径**的（每次调用现取 `app.getPath`）。 */
vi.mock("electron", () => ({
  app: { getPath: (what: string) => (what === "userData" ? env.userData : (() => { throw new Error(what); })()) },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
}));
/** 注册进来的处理器（key = 通道名）。 */
const handlers = new Map<string, (...args: unknown[]) => unknown>();

let sessionStoreMock: {
  list: () => Promise<Array<{ sessionId: string; owner?: string }>>;
  load: (id: string) => Promise<{ records: unknown[] }>;
  /** 追加进来的记录（"授权真的落了一条记录"这条判据要看它）。 */
  appended: Array<{ sessionId: string; records: unknown[] }>;
  append: (id: string, records: unknown[]) => Promise<unknown[]>;
};
vi.mock("../electron/ipc/sessionStore", () => ({
  desktopSessionStore: () => sessionStoreMock,
}));

beforeEach(async () => {
  handlers.clear();
  env.userData = mkdtempSync(path.join(os.tmpdir(), "dh-space-host-"));
  sessionStoreMock = {
    list: async () => [],
    load: async () => ({ records: [] }),
    appended: [],
    append: async (id, records) => {
      sessionStoreMock.appended.push({ sessionId: id, records });
      return records;
    },
  };
  const { registerSpaceIpc } = await import("../electron/ipc/spaceHost");
  registerSpaceIpc();
});
afterEach(() => {
  try {
    rmSync(env.userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* 尽力而为（Windows） */
  }
});

/** 盘上的那份账本（读不出来就抛 —— 测试里那不是合法状态）。 */
function spaceOnDisk() {
  const got = createSpaceStore(env.userData).read();
  if (got.status !== "ok") throw new Error(`账本读不出来：${got.status}`);
  return got.space;
}

/** 调一个 IPC 通道（`handle(channel)` 收 (event, …args)，测试里给个空 event）。 */
const call = <T>(channel: string, ...args: unknown[]): T => handlers.get(channel)!(null, ...args) as T;

type State = ReturnType<typeof spaceStateView>;
type Result = { ok: boolean; note?: string; error?: string; token?: string; code?: string; state?: State };

describe("桌面团队空间（IPC）", () => {
  it("⭐ 发码 → 替他入团：账本真的变了，口令在返回里、**不在**状态里", () => {
    /* 空账：只有主人 */
    const initial = call<State>(SPACE_CHANNEL.state);
    expect(initial.members.map((m) => m.id)).toEqual(["local"]);
    expect(initial.members[0]!.isOwner).toBe(true);
    expect(initial.shared).toEqual([]);

    const invited = call<Result>(SPACE_CHANNEL.invite, { roles: ["viewer"] });
    expect(invited.ok).toBe(true);
    const code = invited.code!;
    expect(code).toMatch(/^[0-9A-Z]{8}$/);
    expect(invited.state!.pendingCodes.map((c) => c.code)).toEqual([code]);

    /* 账本里真有这张码 */
    expect(spaceOnDisk().roster.codes).toHaveLength(1);

    const joined = call<Result>(SPACE_CHANNEL.join, { code, memberId: "alice", displayName: "Alice" });
    expect(joined.ok).toBe(true);
    expect(joined.token).toMatch(/^sk-/);
    expect(joined.state!.members.map((m) => m.id).sort()).toEqual(["alice", "local"]);
    /* 口令**只在这条返回里**：状态里没有任何一格带它 */
    expect(JSON.stringify(joined.state)).not.toContain(joined.token!);
    /* 名册里的角色是只读起步 */
    expect(joined.state!.members.find((m) => m.id === "alice")!.roles).toEqual(["viewer"]);
    /* 一码一人 */
    const again = call<Result>(SPACE_CHANNEL.join, { code, memberId: "bob" });
    expect(again.ok).toBe(false);
  });

  it("⭐ 改角色 / 移除：主人动不了，移除连口令一起作废", () => {
    const code = call<Result>(SPACE_CHANNEL.invite, {}).code!;
    call<Result>(SPACE_CHANNEL.join, { code, memberId: "bob" });

    const promoted = call<Result>(SPACE_CHANNEL.setRoles, { memberId: "bob", roles: ["specialist"] });
    expect(promoted.ok).toBe(true);
    expect(rolesIn(spaceOnDisk().roster, "bob")).toEqual(["specialist"]);

    /* 主人不能被改（自己给自己升权是这类模型最经典的洞） */
    expect(call<Result>(SPACE_CHANNEL.setRoles, { memberId: "local", roles: ["viewer"] }).ok).toBe(false);

    const removed = call<Result>(SPACE_CHANNEL.remove, { memberId: "bob" });
    expect(removed.ok).toBe(true);
    const after = spaceOnDisk();
    expect(after.tokens.bob, "移除要连口令一起作废").toBeUndefined();
    expect(after.roster.members.some((m) => m.id === "bob")).toBe(false);
  });

  it("⭐ 共享 / 指定持有人：未共享先拒；取消共享把持有人一并清掉", () => {
    const code = call<Result>(SPACE_CHANNEL.invite, {}).code!;
    call<Result>(SPACE_CHANNEL.join, { code, memberId: "alice" });

    /* 未共享就指定持有人 → 拒（"先共享再接管"） */
    expect(call<Result>(SPACE_CHANNEL.takeover, { sessionId: "task-x", memberId: "alice" }).ok).toBe(false);

    const shared = call<Result>(SPACE_CHANNEL.share, "task-x");
    expect(shared.ok).toBe(true);
    expect(shared.state!.shared).toEqual(["task-x"]);

    /* 不在空间里的人不能当持有人 */
    expect(call<Result>(SPACE_CHANNEL.takeover, { sessionId: "task-x", memberId: "stranger" }).ok).toBe(false);

    const taken = call<Result>(SPACE_CHANNEL.takeover, { sessionId: "task-x", memberId: "alice" });
    expect(taken.ok).toBe(true);
    expect(taken.state!.holders["task-x"]).toBe("alice");

    const unshared = call<Result>(SPACE_CHANNEL.unshare, "task-x");
    expect(unshared.ok).toBe(true);
    expect(unshared.state!.shared).toEqual([]);
    expect(unshared.state!.holders["task-x"], "取消共享要连持有人一起清").toBeUndefined();
  });

  it("⭐ 共享入口的候选清单：问的是**本机会话库**（列得出来的就能共享）", async () => {
    sessionStoreMock = {
      list: async () => [
        { sessionId: "task-a", title: "甲对话", owner: "local" },
        { sessionId: "task-b", title: "", owner: "alice" },
      ],
      load: async () => ({ records: [] }),
      appended: [],
      append: async (id, records) => {
        sessionStoreMock.appended.push({ sessionId: id, records });
        return records;
      },
    };
    const { shareableSessions } = await import("../electron/ipc/spaceHost");
    const rows = await shareableSessions();
    expect(rows.map((r) => r.sessionId)).toEqual(["task-a", "task-b"]);
    /* 没标题的用 id 顶上（界面上不能出现空行） */
    expect(rows[1]!.title).toBe("task-b");
    expect(rows[1]!.owner).toBe("alice");
  });

  it("⭐ 建加密房间：账本里**只有房间号**（密钥绝不落盘），链接里能拿回密钥", async () => {
    const code = call<Result>(SPACE_CHANNEL.invite, {}).code!;
    call<Result>(SPACE_CHANNEL.join, { code, memberId: "alice" });
    call<Result>(SPACE_CHANNEL.share, "task-room");

    const { openRoomFor } = await import("../electron/ipc/spaceHost");
    /* 没共享不能建（房间是给另一端进的） */
    expect(openRoomFor({ sessionId: "task-other" }).ok).toBe(false);

    const got = openRoomFor({ sessionId: "task-room" });
    expect(got.ok, got.ok ? "" : got.error).toBe(true);
    if (!got.ok) return;
    expect(got.roomId).toMatch(/^r-/);
    expect(got.fragment).toMatch(/^#[A-Za-z0-9_-]+$/);

    /* ① 账本里只有房间号：**把整个账本序列化也找不到密钥** */
    const stored = JSON.stringify(spaceOnDisk());
    expect(stored).toContain(got.roomId);
    expect(stored.includes(got.fragment.slice(1)), "密钥落进账本了（零知识就没了）").toBe(false);

    /* ② 收端拿完整链接能取回房间号与密钥（`parseRoomLink` 只认 fragment） */
    const { parseRoomLink } = await import("@engine/sync/e2ee");
    const link = `https://example.test/r/${got.roomId}${got.fragment}`;
    const parsed = parseRoomLink(link);
    expect(parsed?.roomId).toBe(got.roomId);
    expect(`#${parsed?.key}`).toBe(got.fragment);
    /* query 里那份**不算**（会进服务端日志） */
    expect(parseRoomLink(`https://example.test/r/${got.roomId}?key=${got.fragment.slice(1)}`)).toBeNull();

    /* ③ 状态视图里只有房间号（界面拿得到的那一份也不含密钥） */
    expect(call<State>(SPACE_CHANNEL.state).rooms).toEqual([{ sessionId: "task-room", roomId: got.roomId }]);
  });

  it("⭐ 授权他人批（审批卡片那颗）：落一条 approval-grant 记录，重复授不再记", async () => {
    const pending = [
      { requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: "x.md" }, actor: { id: "main", kind: "agent" } },
      {
        requestId: "r1",
        type: "tool-result",
        toolCallId: "c1",
        toolName: "write_file",
        output: { pending: true, notice: "等确认", approvers: ["local"] },
        actor: { id: "main", kind: "agent" },
      },
    ];
    /*
     * ⚠️ 这个假库要**有状态**：append 过的记录，之后的 load 得看得见 ——
     * 不然"重复授权"那一条永远红（因为第二次读回来的还是那份没授权的记录），
     * 而那不是产品的问题，是我的假库在说谎。
     */
    const live: unknown[] = [...pending];
    sessionStoreMock = {
      list: async () => [{ sessionId: "task-grant", owner: "local" }],
      load: async () => ({ records: [...live] }),
      appended: [],
      append: async (id, records) => {
        sessionStoreMock.appended.push({ sessionId: id, records });
        live.push(...records);
        return records;
      },
    };
    const { authorizePendingApprover } = await import("../electron/ipc/spaceHost");

    const first = await authorizePendingApprover({ sessionId: "task-grant", toolCallId: "c1", target: "bob" });
    expect(first.ok, first.ok ? "" : first.error).toBe(true);
    if (!first.ok) return;
    expect(first.added).toBe(true);
    expect(first.approvers).toEqual(["local", "bob"]);
    /* 落的是**授权记录**（不是决策记录 —— 用拒绝表达授权会把那条待决误判成已处置） */
    const written = sessionStoreMock.appended[0]!.records[0] as { type: string; by?: string; target?: string; approvers?: string[] };
    expect(written.type).toBe("approval-grant");
    expect(written.by).toBe("local");
    expect(written.target).toBe("bob");
    expect(written.approvers).toEqual(["local", "bob"]);

    /* 重复授：不算错，也不再记一条 */
    const again = await authorizePendingApprover({ sessionId: "task-grant", toolCallId: "c1", target: "bob" });
    expect(again.ok && again.added === false, "重复授权该如实说「已经在名单里」").toBe(true);
    expect(sessionStoreMock.appended, "重复授权不该再记一条").toHaveLength(1);
  });

  it("⭐ 账本：按成员汇总读的是**真会话库**（数字只来自 provider 上报）", async () => {
    sessionStoreMock = {
      list: async () => [{ sessionId: "task-1", owner: "alice" }],
      appended: [],
      append: async (id, records) => {
        sessionStoreMock.appended.push({ sessionId: id, records });
        return records;
      },
      load: async () => ({
        records: [
          { seq: 1, at: 1_700_000_000_000, requestId: "r1", type: "request", provider: "strata", model: "deepseek-flash", messages: [], actor: { id: "alice", kind: "user" } },
          { seq: 2, at: 1_700_000_000_100, requestId: "r1", type: "done", usage: { inputTokens: 100, outputTokens: 20 }, actor: { id: "main", kind: "agent" } },
        ],
      }),
    };
    const usage = await spaceUsage();
    expect(usage.turns).toBe(1);
    expect(usage.byMember).toEqual([{ key: "alice", turns: 1, totalTokens: 120 }]);
    expect(usage.inputTokens).toBe(100);
  });
});
