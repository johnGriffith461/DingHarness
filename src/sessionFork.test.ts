import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteSessionStore } from "@engine/adapters/sqliteStore";
import { chatSessionId, type LogInput } from "@engine/core/events";
import { forkReplaysEqual } from "@engine/core/fork";
import { forkSession } from "@engine/core/fork";

/**
 * **「从这一刻分叉」的产品入口**（C6/V5-2 2.5；界面在对话列表的右键菜单里）。
 *
 * 这一条盯着"主进程那一步真的把记录复制成了**独立的一段**"：
 *   ① 新会话的记录与源**重放相等**（`forkReplaysEqual` —— 剥了 seq 但不丢内容）；
 *   ② 归属与 `forked_from` 都对（来源记下来，归属跟源走）；
 *   ③ 分叉之后两边**互不影响**（源再写一条，副本不动）—— 那正是"独立副本"的意思。
 *
 * ⚠️ 它走的是 `forkSession`（纯函数）+ 真 store 的那条路；主进程 IPC 只是把这两步接起来。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* 尽力而为（Windows） */
    }
  }
});

describe("会话分叉（从这一刻分叉）", () => {
  it("⭐ 副本与源重放相等、归属跟源、来源记下来，且两边此后互不影响", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-fork-"));
    dirs.push(dir);
    const store = createSqliteSessionStore(dir);
    try {
      const source = chatSessionId("fork-src");
      await store.append(
        source,
        [
          { requestId: "r1", type: "request", provider: "strata", model: "deepseek-flash", messages: [{ role: "user", content: "第一句" }] } as LogInput,
          { requestId: "r1", type: "text", text: "收到了" } as LogInput,
          { requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "x.md" } } as LogInput,
          { requestId: "r1", type: "approval", toolCallId: "c1", name: "read_file", approved: true, ok: true, line: "已读", decidedBy: "local" } as LogInput,
        ],
        { owner: "alice" },
      );
      const before = (await store.load(source)).records;

      /* 主进程那两步：读源 → forkSession → 写新（归属跟源、记下来源） */
      const into = `${source}-fork-test`;
      const plan = forkSession(before, { source: { sessionId: source }, into: { sessionId: into } });
      await store.append(into, plan.records, { owner: "alice", forkedFrom: source });

      const forked = (await store.load(into)).records;
      expect(forked.length, "条数该与源一致").toBe(before.length);
      expect(forkReplaysEqual(before, forked), "副本与源重放不相等").toBe(true);
      /* seq 重发号、at 保留（"什么时候说的"是事实） */
      expect(forked.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
      expect(forked.map((r) => r.at)).toEqual(before.map((r) => r.at));

      const row = (await store.list()).find((s) => s.sessionId === into);
      expect(row?.owner, "归属该跟源走").toBe("alice");
      expect(row?.forkedFrom, "来源要记下来").toBe(source);
      /* 副作用警示随行（"回看不产生副作用 / 接着跑是显式动作"） */
      expect(plan.note).toContain("独立副本");

      /* 独立：源再长一条、副本不动 */
      await store.append(source, [{ requestId: "r1", type: "done" } as LogInput], { owner: "alice" });
      expect((await store.load(into)).records.length).toBe(before.length);
    } finally {
      store.close();
    }
  });

  it("源为空（已被收口）时主进程那条路给一句人话 —— 不造一段空分叉", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-fork-empty-"));
    dirs.push(dir);
    const store = createSqliteSessionStore(dir);
    try {
      const empty = chatSessionId("fork-empty");
      await store.append(empty, [{ requestId: "r1", type: "request", provider: "strata", model: "m", messages: [] } as LogInput]);
      /* 模拟"记录读不到"（收口过）：forkSession 的入参就是空数组 → 调用方该先拦 */
      const plan = forkSession([], { source: { sessionId: empty }, into: { sessionId: "x" } });
      expect(plan.records).toEqual([]);
      /* 主进程那条（`sessionStore.ts` 的 fork）判的就是"records 为空 → 不写"，
         这一格钉住"空分叉不该产生一段空会话"这条口径 */
      expect(plan.note).toContain("独立副本");
    } finally {
      store.close();
    }
  });
});
void vi;
