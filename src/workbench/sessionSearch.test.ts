import { describe, expect, it, vi } from "vitest";

import type { SessionSearchHit, ShellBridge } from "@shared/ipc";
import { hitKindLabel, openableTaskId, searchSessions } from "./sessionSearch";

/**
 * 左栏搜索的渲染侧逻辑（2026-10-17，V5 开工前清尾 #3）。
 *
 * 这条接的是 Phase 12.4 的会话检索（`session:search`）。组件那一层没有渲染环境，
 * 所以这里钉住三件事：桥的口径、能不能打开、标签 —— 组件只负责把它们画出来。
 */

function hit(sessionId: string): SessionSearchHit {
  return { sessionId, conversationId: sessionId, title: "t", updatedAt: 0, bytes: 0, excerpt: "e", hits: 1 };
}

/** 装一个假桥（用完必须拆，避免串到别的用例）。 */
function withShell(search: ShellBridge["session"]["search"]): void {
  (globalThis as unknown as { shell?: Partial<ShellBridge> }).shell = { session: { search } as ShellBridge["session"] };
}

function clearShell(): void {
  delete (globalThis as unknown as { shell?: unknown }).shell;
}

describe("左栏搜索 · 渲染侧逻辑", () => {
  it("空查询不发请求（回空结果 —— 不是「全部」）", async () => {
    const spy = vi.fn();
    withShell(spy as unknown as ShellBridge["session"]["search"]);
    try {
      expect(await searchSessions("   ")).toEqual({ ok: true, hits: [] });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      clearShell();
    }
  });

  it("检索经桥走（返回原样搬回）", async () => {
    withShell((async (q: string) => [hit(`task-${q}`)]) as ShellBridge["session"]["search"]);
    try {
      const got = await searchSessions("周报");
      expect(got.ok).toBe(true);
      if (got.ok) expect(got.hits[0]!.sessionId).toBe("task-周报");
    } finally {
      clearShell();
    }
  });

  it("桥不在 / 它抛错：如实回报，不静默当「没搜到」", async () => {
    clearShell();
    const noBridge = await searchSessions("x");
    expect(noBridge.ok).toBe(false);

    withShell((async () => {
      throw new Error("库打不开");
    }) as ShellBridge["session"]["search"]);
    try {
      const bad = await searchSessions("x");
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toContain("库打不开");
    } finally {
      clearShell();
    }
  });

  it("⭐ 能不能打开：`task-<id>` 与**裸任务 id** 都要认；别的种类只能看片段", () => {
    const has = (id: string) => id === "t1" || id === "tmv9";
    expect(openableTaskId(hit("task-t1"), has)).toBe("t1");
    /* 裸任务 id：工作台一轮对话的记录用的是它（审批留痕才用 `task-` 前缀）——
       这是实测撞见的一处不一致，见 `sessionSearch.ts` 里那段说明 */
    expect(openableTaskId(hit("tmv9"), has)).toBe("tmv9");
    /* 任务已经被删了（会话记录还在）—— 不能给一个打开就报"任务不存在"的东西 */
    expect(openableTaskId(hit("task-gone"), has)).toBeNull();
    expect(openableTaskId(hit("gone"), has)).toBeNull();
    /* 历史对话 / 命令行记录：本机版没有它们的查看页 */
    expect(openableTaskId(hit("chat-c1"), has)).toBeNull();
    expect(openableTaskId(hit("cli-r1"), has)).toBeNull();
  });

  it("种类标签按前缀给（前缀语义与 engine/core/events.ts 的 SESSION_PREFIX 一致）", () => {
    expect(hitKindLabel("task-x")).toBe("任务");
    expect(hitKindLabel("chat-x")).toBe("对话");
    expect(hitKindLabel("cli-x")).toBe("命令行");
    expect(hitKindLabel("认不出来")).toBe("记录");
  });
});
