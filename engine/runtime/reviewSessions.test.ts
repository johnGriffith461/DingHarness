import { describe, expect, it } from "vitest";

import { loadReviewRecords, type RecordLike } from "./reviewSessions";

/**
 * T-01：改动审阅的**读路径**要兼容旧数据。
 *
 * 背景：新数据一律写 `task-<id>`；旧数据（P0 之前）写在裸 `<id>` 下。
 * 只读新会话的话，老用户的"改了什么 / 回滚"会整片消失 —— 那是**只读旧写新**的反面。
 *
 * 判据：先读 `task-`；有旧数据时合并按 `toolCallId` 去重；顺序按时间。
 */
function call(id: string, name: string, at: number): RecordLike {
  return { seq: at, at, type: "tool-call", toolCallId: id, toolName: name, input: { path: "a.ts" } };
}
function result(id: string, name: string, at: number): RecordLike {
  return { seq: at, at, type: "tool-result", toolCallId: id, toolName: name, output: { ok: true } };
}

describe("loadReviewRecords", () => {
  it("新数据只读 task- 会话", async () => {
    const asked: string[] = [];
    const got = await loadReviewRecords("t1", async (id) => {
      asked.push(id);
      if (id === "task-t1") return { records: [call("c1", "write_file", 1), result("c1", "write_file", 2)] };
      return { records: [] };
    });
    expect(asked[0]).toBe("task-t1");
    expect(got).toHaveLength(2);
  });

  it("旧数据（裸 id）能被回退读到", async () => {
    const got = await loadReviewRecords("t1", async (id) =>
      id === "t1" ? { records: [call("c1", "write_file", 1), result("c1", "write_file", 2)] } : { records: [] },
    );
    expect(got).toHaveLength(2);
    expect(got[0]?.toolCallId).toBe("c1");
  });

  it("两边都有时合并、按 toolCallId 去重、按时间排序", async () => {
    const got = await loadReviewRecords("t1", async (id) => {
      if (id === "task-t1") return { records: [call("c2", "edit_file", 5), result("c2", "edit_file", 6)] };
      return { records: [call("c1", "write_file", 1), result("c1", "write_file", 2), call("c2", "edit_file", 5), result("c2", "edit_file", 6)] };
    });
    /* 4 条（c1 两条 + c2 两条），不是 6 条 */
    expect(got).toHaveLength(4);
    expect(got.map((r) => r.at)).toEqual([1, 2, 5, 6]);
  });

  it("已带前缀的 id 不会变成 task-task-", async () => {
    const asked: string[] = [];
    await loadReviewRecords("task-t1", async (id) => {
      asked.push(id);
      return { records: [] };
    });
    expect(asked).toContain("task-t1");
    expect(asked.some((id) => id.includes("task-task-"))).toBe(false);
  });

  it("空 id → 不读任何会话", async () => {
    const asked: string[] = [];
    const got = await loadReviewRecords("", async (id) => {
      asked.push(id);
      return { records: [] };
    });
    expect(asked).toEqual([]);
    expect(got).toEqual([]);
  });
});
