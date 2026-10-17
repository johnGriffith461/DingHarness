import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { createApprovalsIndex } from "../../engine/adapters/sqliteApprovals";
import { createSpaceStore } from "../../engine/adapters/spaceStore";
import { chatSessionId, type LogInput } from "../../engine/core/events";
import { createCliExecutor } from "../cli/tools";
import { buildToolSet, createToolRegistry } from "../../engine/runtime/registry";
import { boot, call, cleanupDirs, stopEverything } from "./testKit";

/**
 * **审批的 HTTP 面**（C3 3.7b，V5 收尾）。
 *
 * 这一组要证明的是"多成员审批流转"从**数据层**走到了**能用的入口**：
 *   ① 待决列表（谁在等批、归谁批、你能不能处置）；
 *   ② 授权他人批（主人把裁决权授给成员 → 落一条授权记录）；
 *   ③ 被授权的人**批准** → 落决策记录（`decidedBy` 是他）+ 工具**真的执行了一次**；
 *   ④ 拒绝 → 只留痕不执行；
 *   ⑤ 没有裁决权的人动不了（403 not-approver）；已经处置过的再来一次是 409（stale，幂等）；
 *   ⑥ 执行体拿不到时如实说"决定可以留痕，但执行要在会话所在的那一端做"（501），不假装执行过。
 *
 * 这里的执行体是**真**的（`createCliExecutor` + 内置工具集），所以判据能落到
 * "磁盘上真出现了那个文件" —— 而不是"响应里说成功了"。
 */

afterEach(async () => {
  await stopEverything();
});

/** 起一个带审批面的服务：真会话库 + 真审批索引 + 真执行体。 */
async function bootApprovals(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-approvals-http-"));
  cleanupDirs.push(dir);
  const store = createSqliteSessionStore(dir);
  const approvals = createApprovalsIndex(dir);
  const sessionId = chatSessionId("approvals-http");

  /* 一段会话 + 一条**待决**（write_file 被拦下） */
  await store.append(sessionId, [
    { requestId: "r1", type: "request", provider: "fake", model: "fake", messages: [{ role: "user", content: "写个文件" }] } as LogInput,
    { requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: path.join(dir, "written-by-approval.txt"), content: "批准之后写下的" } } as LogInput,
    { requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "write_file", output: { pending: true, notice: "等确认", approvers: ["local"] } } as LogInput,
  ]);
  store.close();

  const started = await boot({
    listSessions: async () => {
      const s = createSqliteSessionStore(dir);
      try {
        return await s.list();
      } finally {
        s.close();
      }
    },
    loadSession: async (id: string) => {
      const s = createSqliteSessionStore(dir);
      try {
        return await s.load(id);
      } finally {
        s.close();
      }
    },
    appendRecord: async (id: string, record: unknown) => {
      const s = createSqliteSessionStore(dir);
      try {
        await s.append(id, [record as LogInput]);
      } finally {
        s.close();
      }
    },
    approvals,
    /* 团队空间账本：授权那条用例要发码/入团/共享/接管（没有它那几族会 501） */
    space: createSpaceStore(dir),
    /* 真执行体：与 CLI 同一条装配（内置工具集） */
    makeEngine: async (cwd: string) => {
      const registry = createToolRegistry({});
      const executor = createCliExecutor({
        dirs: [cwd],
        makeTools: (mode, depth, provider, signal, only) =>
          buildToolSet({
            registry,
            mode,
            executor: executor as never,
            ctx: { mode, provider, depth, ...(signal ? { signal } : {}) },
            ...(only ? { only } : {}),
          }),
      });
      return {
        engine: {
          async run() {
            throw new Error("这一组不跑整轮");
          },
          async resume() {
            return { turns: [], pending: [] };
          },
          tools: registry,
        } as never,
        close: () => undefined,
        executor,
      };
    },
    cwd: dir,
    ...over,
  });
  return { ...started, dir, sessionId, approvals };
}

const boss = (token: string) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" });
const jsonOf = (res: { text: string }) => JSON.parse(res.text) as Record<string, unknown>;

describe("审批的 HTTP 面（C3 3.7b）", () => {
  it("⭐ 待决列表：主人看得到，成员看不到（没共享）", async () => {
    const { port, token, sessionId, dir } = await bootApprovals();
    const listed = await call(port, "/v1/approvals?session=" + encodeURIComponent(sessionId), { headers: boss(token) });
    expect(listed.status).toBe(200);
    const body = jsonOf(listed) as { approvals: Array<{ toolCallId: string; approvers: string[]; name: string; youCanDecide: boolean }> };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]!.toolCallId).toBe("c1");
    expect(body.approvals[0]!.approvers).toEqual(["local"]);
    expect(body.approvals[0]!.youCanDecide, "主人当然能批").toBe(true);
    cleanupDirs.push(dir);
  });

  it("⭐ 授权 → 批准 → 工具真的执行一次 + 两条记录都留痕", async () => {
    const { port, token, sessionId, dir } = await bootApprovals();
    /* 先入团一个成员，并把它列为可读（共享这段会话） */
    const code = jsonOf(await call(port, "/v1/space/invite", { method: "POST", headers: boss(token), body: "{}" })).code as string;
    const aliceToken = jsonOf(
      await call(port, "/v1/space/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, memberId: "alice" }),
      }),
    ).token as string;
    /* 先共享（接管要求"已经共享出来"），顺序反过来会被 409 挡下 */
    const shared = await call(port, `/v1/space/share/${encodeURIComponent(sessionId)}`, { method: "POST", headers: boss(token) });
    expect(shared.status, shared.text).toBe(200);
    const taken = await call(port, `/v1/space/takeover/${encodeURIComponent(sessionId)}`, { method: "POST", headers: boss(aliceToken) });
    expect(taken.status, taken.text).toBe(200);

    /* 成员看得到待决，但**现在不能批**（审批人是主人） */
    const listRes = await call(port, "/v1/approvals", { headers: boss(aliceToken) });
    expect(listRes.status, listRes.text).toBe(200);
    const before = jsonOf(listRes) as { approvals: Array<{ toolCallId: string; youCanDecide: boolean }> };
    expect(before.approvals).toHaveLength(1);
    expect(before.approvals[0]!.youCanDecide).toBe(false);
    const refused = await call(port, `/v1/approvals/${encodeURIComponent(sessionId)}/c1`, {
      method: "POST",
      headers: boss(aliceToken),
      body: JSON.stringify({ action: "approve" }),
    });
    expect(refused.status, "没有裁决权的人不能批").toBe(403);
    expect(jsonOf(refused).error).toContain("不归你批");

    /* 主人授权给她 → 她自己也能批了 */
    const granted = await call(port, `/v1/approvals/${encodeURIComponent(sessionId)}/c1`, {
      method: "POST",
      headers: boss(token),
      body: JSON.stringify({ action: "authorize", target: "alice" }),
    });
    expect(granted.status).toBe(200);
    expect(jsonOf(granted).approvers).toEqual(["local", "alice"]);
    /* 幂等：再授一次不算错、也不再记一条 */
    const again = jsonOf(
      await call(port, `/v1/approvals/${encodeURIComponent(sessionId)}/c1`, {
        method: "POST",
        headers: boss(token),
        body: JSON.stringify({ action: "authorize", target: "alice" }),
      }),
    );
    expect(again.added).toBe(false);

    /* 她批准 → 工具**真跑了一次** */
    const approved = await call(port, `/v1/approvals/${encodeURIComponent(sessionId)}/c1`, {
      method: "POST",
      headers: boss(aliceToken),
      body: JSON.stringify({ action: "approve" }),
    });
    expect(approved.status).toBe(200);
    const got = jsonOf(approved);
    expect(got.state).toBe("approved");
    expect(got.decidedBy).toBe("alice");
    expect(existsSync(path.join(dir, "written-by-approval.txt")), "批准之后那个文件该真的出现").toBe(true);
    expect(readFileSync(path.join(dir, "written-by-approval.txt"), "utf8")).toContain("批准之后写下的");

    /* 幂等：同一条再来一次是 409（stale），**不会又执行一遍** */
    const second = await call(port, `/v1/approvals/${encodeURIComponent(sessionId)}/c1`, {
      method: "POST",
      headers: boss(aliceToken),
      body: JSON.stringify({ action: "approve" }),
    });
    expect(second.status).toBe(409);
    expect(jsonOf(second).error).toContain("已经处置过");

    /* 留痕：授权一条 + 决策一条，决策带 decidedBy=alice 与执行结果 */
    const store = createSqliteSessionStore(dir);
    const records = (await store.load(sessionId)).records as Array<{ type: string; decidedBy?: string; by?: string; target?: string; ok?: boolean }>;
    store.close();
    const grants = records.filter((r) => r.type === "approval-grant");
    const decisions = records.filter((r) => r.type === "approval");
    expect(grants).toHaveLength(1);
    expect(grants[0]!.by).toBe("local");
    expect(grants[0]!.target).toBe("alice");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decidedBy).toBe("alice");
    expect(decisions[0]!.ok).toBe(true);
  });

  it("⭐ 拒绝：留痕但不执行（磁盘上什么都不该出现）", async () => {
    const { port, token, sessionId, dir } = await bootApprovals();
    const rejected = await call(port, `/v1/approvals/${encodeURIComponent(sessionId)}/c1`, {
      method: "POST",
      headers: boss(token),
      body: JSON.stringify({ action: "reject" }),
    });
    expect(rejected.status).toBe(200);
    expect(jsonOf(rejected).state).toBe("rejected");
    expect(existsSync(path.join(dir, "written-by-approval.txt"))).toBe(false);
    const store = createSqliteSessionStore(dir);
    const decisions = (await store.load(sessionId)).records.filter((r: { type?: string }) => r.type === "approval") as Array<{
      approved?: boolean;
      output?: unknown;
    }>;
    store.close();
    expect(decisions[0]!.approved).toBe(false);
    expect(decisions[0]!.output, "拒绝不执行 → 不该带执行结果").toBeUndefined();
  });

  it("主人批准：执行 + 留痕（本机那条路在服务端的等价物）", async () => {
    const { port, token, sessionId, dir } = await bootApprovals();
    const approved = jsonOf(
      await call(port, `/v1/approvals/${encodeURIComponent(sessionId)}/c1`, {
        method: "POST",
        headers: boss(token),
        body: JSON.stringify({ action: "approve" }),
      }),
    );
    expect(approved.state).toBe("approved");
    expect(existsSync(path.join(dir, "written-by-approval.txt"))).toBe(true);
  });

  it("执行体拿不到时：如实说「留痕但执行在另一端」，不假装执行过", async () => {
    const { port, token, sessionId, dir } = await bootApprovals({
      makeEngine: async () => ({
        engine: { run: async () => ({}), resume: async () => ({ turns: [], pending: [] }), tools: {} } as never,
        close: () => undefined,
        /* 故意**不给** executor —— 装置型宿主就是这样 */
      }),
    });
    const res = await call(port, `/v1/approvals/${encodeURIComponent(sessionId)}/c1`, {
      method: "POST",
      headers: boss(token),
      body: JSON.stringify({ action: "approve" }),
    });
    expect(res.status).toBe(501);
    expect(jsonOf(res).error).toContain("执行要在会话所在的那一端做");
    expect(existsSync(path.join(dir, "written-by-approval.txt"))).toBe(false);
    /* 决定**没有**落痕（501 = 这一步没做，不是"做了但没执行"） */
    const store = createSqliteSessionStore(dir);
    const decisions = (await store.load(sessionId)).records.filter((r: { type?: string }) => r.type === "approval");
    store.close();
    expect(decisions).toHaveLength(0);
  });

  it("没接会话写入（appendRecord）时整族 501 —— 落不了痕的决定不做", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-approvals-nowrite-"));
    cleanupDirs.push(dir);
    const approvals = createApprovalsIndex(dir);
    const { port, token } = await boot({
      approvals,
      appendRecord: undefined,
      listSessions: async () => [],
      loadSession: async () => ({ records: [] }),
    });
    const res = await call(port, "/v1/approvals", { headers: boss(token) });
    expect(res.status).toBe(501);
    expect(jsonOf(res).error).toContain("落不了痕");
  });
});
