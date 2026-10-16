import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

import { parseSse } from "../cli/cmdConnect";
import { createSpaceStore } from "../../engine/adapters/spaceStore";
import type { ServerOptions } from "./agentServer";
import { boot, call, cleanupDirs, collectSse, stopEverything } from "./testKit";

/*
 * 这一组的装置从 `./testKit` 拿 —— 它们从 `agentServer.test.ts` 里搬出来，
 * 原因是那个文件撞了巨石守卫（900 行）；搬的划分是"这一组在验什么"：
 *   · SSE 事件流的 actor（V5-2 2.3）；
 *   · 团队空间（V5-3 3.1/3.2/3.5：邀请即入 / 只读起步 / 共享可读 / 接管能写 / 撤权即时）。
 */

afterEach(async () => {
  await stopEverything();
});

/**
 * SSE 事件流的 actor 维度（V5-2 任务 2.3）。
 *
 * 判据三条：① 第一帧 `started` 说明"谁发起的"（成员身份）；
 * ② 事件帧与 `done` 帧都带 agent 那一侧的 actor（与内核记日志同一个常量）；
 * ③ 成员往**别人的会话**里写：先拒（403）—— 归属在 C1 是硬墙，
 *    而"跑完发现记不进去"那种静默是这一层要避免的。
 */
describe("SSE 事件流带上 actor（V5-2 2.3）", () => {

  it("⭐ 第一帧说明谁发起的；事件帧与 done 帧带 agent 的 actor", async () => {
    const members = [{ id: "alice", token: "sk-alice-123" }];
    const { port } = await boot({ members });
    const text = await collectSse(
      port,
      "/v1/run",
      JSON.stringify({ message: "你好" }),
      { Authorization: "Bearer sk-alice-123", "content-type": "application/json" },
    );
    const frames = parseSse(text).events;
    const names = frames.map((f) => f.event);
    expect(names[0], "第一帧不是 started").toBe("started");
    expect((frames[0]!.data as { actor: { id: string; kind: string } }).actor).toEqual({ id: "alice", kind: "user" });

    const eventFrames = frames.filter((f) => f.event === "event");
    expect(eventFrames.length, "一条事件帧都没有？").toBeGreaterThan(0);
    for (const frame of eventFrames) {
      expect((frame.data as { actor?: { id: string } }).actor, `事件帧没带 actor：${JSON.stringify(frame.data)}`).toEqual({
        id: "main",
        kind: "agent",
      });
    }
    const done = frames.find((f) => f.event === "done");
    expect((done?.data as { actor?: { id: string } }).actor).toEqual({ id: "main", kind: "agent" });
  });

  it("⭐ 成员往别人的会话里写：403（不是「跑完发现记不进去」）", async () => {
    const members = [{ id: "alice", token: "sk-alice-123" }];
    const { port } = await boot({
      members,
      listSessions: async () => [
        { sessionId: "task-1", conversationId: "task-1", title: "本机主人的", updatedAt: 1, bytes: 1, owner: "local" },
      ],
    });
    const res = await call(port, "/v1/run", {
      method: "POST",
      headers: { Authorization: "Bearer sk-alice-123", "content-type": "application/json" },
      body: JSON.stringify({ message: "插一句", sessionId: "task-1" }),
    });
    expect(res.status).toBe(403);
    expect(res.text).toContain("归 local");
  });

  it("主人往任何会话里写：照旧（老口径不回归）", async () => {
    const { port, token } = await boot({
      listSessions: async () => [
        { sessionId: "task-1", conversationId: "task-1", title: "谁的都行", updatedAt: 1, bytes: 1, owner: "alice" },
      ],
    });
    const text = await collectSse(
      port,
      "/v1/run",
      JSON.stringify({ message: "你好", sessionId: "task-1" }),
      { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    );
    expect(parseSse(text).events.some((f) => f.event === "started")).toBe(true);
  });
});

/**
 * 团队空间（V5-3 任务 3.1/3.2/3.5）：邀请即入、只读起步、共享可读、接管能写、撤权即时失效。
 *
 * 这一组就是 U8-1/U8-2/U8-5 的**服务端证据**（端到端在 `scripts/verify-team.ts` 里再跑一遍）。
 */
describe("团队空间（V5-3 3.1/3.2/3.5）", () => {
  /** 起一个带空间账本的服务（数据目录用真临时目录 —— 账本要真落盘）。 */
  async function bootSpace(over: Partial<ServerOptions> = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-space-"));
    const store = createSpaceStore(dir);
    const sessions = [
      { sessionId: "task-owner", conversationId: "task-owner", title: "主人的会话", updatedAt: 3, bytes: 1, owner: "local" },
      { sessionId: "task-alice", conversationId: "task-alice", title: "alice 的会话", updatedAt: 2, bytes: 1, owner: "alice" },
    ];
    const started = await boot({ space: store, listSessions: async () => sessions, ...over });
    return { ...started, dir, store };
  }

  const jsonOf = (res: { text: string }) => JSON.parse(res.text) as Record<string, unknown>;

  it("⭐ U8-1 邀请即入：主人发码 → 新人兑码 → 拿到口令、**只读起步**（viewer）", async () => {
    const { port, token, dir } = await bootSpace();
    const boss = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

    const invited = await call(port, "/v1/space/invite", { method: "POST", headers: boss, body: "{}" });
    expect(invited.status).toBe(200);
    const code = jsonOf(invited).code as string;
    expect(jsonOf(invited).roles).toEqual(["viewer"]);

    /* 兑码**不需要** Bearer（凭据是配对码本身） */
    const joined = await call(port, "/v1/space/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, memberId: "alice", displayName: "Alice" }),
    });
    expect(joined.status).toBe(200);
    const aliceToken = jsonOf(joined).token as string;
    expect(aliceToken).toMatch(/^sk-/);
    expect((jsonOf(joined).member as { roles: string[] }).roles).toEqual(["viewer"]);
    /* 「口令只给一次」这句要写清 */
    expect(String(jsonOf(joined).note)).toContain("只显示这一次");

    /* 新口令当场生效；/v1/space 里看得见名册（含角色，不含口令） */
    const space = await call(port, "/v1/space", { headers: { Authorization: `Bearer ${aliceToken}` } });
    expect(space.status).toBe(200);
    const body = jsonOf(space) as { you: { id: string; roles: string[] }; members: Array<{ id: string }> };
    expect(body.you).toEqual({ id: "alice", owner: false, roles: ["viewer"] });
    expect(body.members.map((m) => m.id)).toEqual(["local", "alice"]);
    expect(JSON.stringify(body), "名册里不该有口令").not.toContain(aliceToken);
    cleanupDirs.push(dir);
  });

  it("⭐ 一码一人：同一张码第二次兑 → 409（used）", async () => {
    const { port, token, dir } = await bootSpace();
    const boss = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    const code = jsonOf(await call(port, "/v1/space/invite", { method: "POST", headers: boss, body: "{}" })).code as string;
    await call(port, "/v1/space/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, memberId: "alice" }),
    });
    const second = await call(port, "/v1/space/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, memberId: "bob" }),
    });
    expect(second.status).toBe(409);
    expect(jsonOf(second).reason).toBe("used");
    cleanupDirs.push(dir);
  });

  it("⭐ viewer 不能邀请别人（发码要 owner/admin）", async () => {
    const { port, token, dir } = await bootSpace();
    const boss = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    const code = jsonOf(await call(port, "/v1/space/invite", { method: "POST", headers: boss, body: "{}" })).code as string;
    const aliceToken = jsonOf(
      await call(port, "/v1/space/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, memberId: "alice" }),
      }),
    ).token as string;
    const tryInvite = await call(port, "/v1/space/invite", {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(tryInvite.status).toBe(403);
    cleanupDirs.push(dir);
  });

  it("⭐ U8-2 共享可读：未共享时成员看不到主人的会话；共享之后看得到（内容就是同一批记录）", async () => {
    const { port, token, dir } = await bootSpace();
    const boss = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    const code = jsonOf(await call(port, "/v1/space/invite", { method: "POST", headers: boss, body: "{}" })).code as string;
    const aliceToken = jsonOf(
      await call(port, "/v1/space/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, memberId: "alice" }),
      }),
    ).token as string;
    const alice = { Authorization: `Bearer ${aliceToken}` };

    const before = jsonOf(await call(port, "/v1/sessions", { headers: alice })) as { sessions: Array<{ sessionId: string }> };
    expect(before.sessions.map((s) => s.sessionId), "没共享就看到了主人的会话").toEqual(["task-alice"]);

    /* 共享（主人） */
    expect((await call(port, "/v1/space/share/task-owner", { method: "POST", headers: boss })).status).toBe(200);
    const after = jsonOf(await call(port, "/v1/sessions", { headers: alice })) as { sessions: Array<{ sessionId: string }> };
    expect(after.sessions.map((s) => s.sessionId).sort()).toEqual(["task-alice", "task-owner"]);

    /* `?owner=local` 那是别人的 owner → 仍然 403 */
    expect((await call(port, "/v1/sessions?owner=local", { headers: alice })).status).toBe(403);
    cleanupDirs.push(dir);
  });

  it("⭐ 3.2 接管：共享之后成员接管才写得进去；没接管 → 403（说清先共享再接管）", async () => {
    const { port, token, dir } = await bootSpace();
    const boss = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    const code = jsonOf(await call(port, "/v1/space/invite", { method: "POST", headers: boss, body: "{}" })).code as string;
    const aliceToken = jsonOf(
      await call(port, "/v1/space/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, memberId: "alice" }),
      }),
    ).token as string;
    const alice = { Authorization: `Bearer ${aliceToken}`, "content-type": "application/json" };

    /* 没共享：写被拒 */
    const before = await call(port, "/v1/run", {
      method: "POST",
      headers: alice,
      body: JSON.stringify({ message: "插一句", sessionId: "task-owner" }),
    });
    expect(before.status).toBe(403);

    /* 共享了但没接管：还是拒（写要接管） */
    await call(port, "/v1/space/share/task-owner", { method: "POST", headers: boss });
    const shared = await call(port, "/v1/run", {
      method: "POST",
      headers: alice,
      body: JSON.stringify({ message: "插一句", sessionId: "task-owner" }),
    });
    expect(shared.status).toBe(403);

    /* 接管之后：写放行（SSE 开头 + started 帧里是 alice） */
    const taken = await call(port, "/v1/space/takeover/task-owner", { method: "POST", headers: alice });
    expect(taken.status).toBe(200);
    const text = await collectSse(port, "/v1/run", JSON.stringify({ message: "接管之后说一句", sessionId: "task-owner" }), alice);
    const frames = parseSse(text).events;
    expect(frames[0]?.event).toBe("started");
    expect((frames[0]!.data as { actor: { id: string } }).actor.id).toBe("alice");
    cleanupDirs.push(dir);
  });

  it("⭐ U8-5 撤权即时生效：移除成员 → 他的口令当场 401；再邀请也要重新兑码", async () => {
    const { port, token, dir } = await bootSpace();
    const boss = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    const code = jsonOf(await call(port, "/v1/space/invite", { method: "POST", headers: boss, body: "{}" })).code as string;
    const aliceToken = jsonOf(
      await call(port, "/v1/space/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, memberId: "alice" }),
      }),
    ).token as string;
    const alice = { Authorization: `Bearer ${aliceToken}` };
    expect((await call(port, "/v1/space", { headers: alice })).status).toBe(200);

    const removed = await call(port, "/v1/space/members/alice", { method: "DELETE", headers: boss });
    expect(removed.status).toBe(200);
    /* **下一请求**就 401（口令从账上删了，且服务端不缓存 —— U8-5 的"即时"） */
    expect((await call(port, "/v1/space", { headers: alice })).status).toBe(401);
    expect((await call(port, "/v1/sessions", { headers: alice })).status).toBe(401);
    cleanupDirs.push(dir);
  });

  it("非成员拿自己的口令（不是这个空间的）→ 403；主人什么都能看", async () => {
    const { port, token, dir } = await bootSpace({ members: [{ id: "stranger", token: "sk-stranger" }] });
    const outsider = { Authorization: "Bearer sk-stranger" };
    const res = await call(port, "/v1/space", { headers: outsider });
    expect(res.status).toBe(403);
    expect(res.text).toContain("不在这个空间里");

    const boss = { Authorization: `Bearer ${token}` };
    const mine = jsonOf(await call(port, "/v1/sessions", { headers: boss })) as { sessions: unknown[] };
    expect(mine.sessions).toHaveLength(2);
    cleanupDirs.push(dir);
  });


  it("⭐ 3.3 审计端点：owner/admin 查得到（按人过滤）；viewer 与非成员 403；没接线 501", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-audit-"));
    const store = createSpaceStore(dir);
    const records = [
      { seq: 1, at: 10, requestId: "r", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "alice 问的" }], actor: { id: "alice", kind: "user" } },
      { seq: 2, at: 20, requestId: "r", type: "text", text: "答", actor: { id: "main", kind: "agent" } },
      { seq: 3, at: 30, requestId: "r2", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "主人的话" }], actor: { id: "local", kind: "user" } },
    ];
    const { port, token } = await boot({
      space: store,
      listSessions: async () => [
        { sessionId: "task-1", conversationId: "task-1", title: "t", updatedAt: 1, bytes: 1, owner: "local" },
      ],
      loadSession: async () => ({ records }),
    });
    const boss = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

    const all = await call(port, "/v1/audit", { headers: boss });
    expect(all.status).toBe(200);
    const body = JSON.parse(all.text) as { entries: Array<{ actor: { id: string }; action: string }>; summary: unknown[] };
    expect(body.entries.map((e) => e.actor.id).sort()).toEqual(["alice", "local"]);
    expect(body.summary).toHaveLength(2);

    const onlyAlice = JSON.parse((await call(port, "/v1/audit?member=alice", { headers: boss })).text) as {
      entries: Array<{ actor: { id: string } }>;
    };
    expect(onlyAlice.entries.map((e) => e.actor.id)).toEqual(["alice"]);

    /* alice 是 viewer → 403（审计只有 owner/admin 能查）；非成员也 403 */
    const code = JSON.parse(
      (await call(port, "/v1/space/invite", { method: "POST", headers: boss, body: "{}" })).text,
    ).code as string;
    const aliceToken = JSON.parse(
      (
        await call(port, "/v1/space/join", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, memberId: "alice" }),
        })
      ).text,
    ).token as string;
    expect((await call(port, "/v1/audit", { headers: { Authorization: `Bearer ${aliceToken}` } })).status).toBe(403);

    cleanupDirs.push(dir);
  });

  it("审计没接会话库：501（不假装「没有记录」）", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-audit2-"));
    const { port, token } = await boot({ space: createSpaceStore(dir) });
    const res = await call(port, "/v1/audit", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(501);
    cleanupDirs.push(dir);
  });

  it("空间没接线：/v1/space/* 回 501（join 也一样 —— 不假装能入团）", async () => {
    const { port, token } = await boot();
    const boss = { Authorization: `Bearer ${token}` };
    expect((await call(port, "/v1/space", { headers: boss })).status).toBe(501);
    expect(
      (await call(port, "/v1/space/join", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
        .status,
    ).toBe(501);
  });
});
