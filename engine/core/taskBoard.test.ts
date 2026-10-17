import { describe, expect, it } from "vitest";

import {
  ackMessages,
  addTask,
  boardSummary,
  claimTask,
  createBoard,
  finishTask,
  inboxOf,
  isClaimable,
  postMessage,
  wouldCycle,
} from "./taskBoard";

/**
 * 任务板（L02）。
 *
 * 判据：依赖无环、认领要等上游完成、**CAS 冲突不覆盖**、信箱按人隔离。
 */

const T = 1_700_000_000_000;
const add = (board: ReturnType<typeof createBoard>, id: string, blockedBy: string[] = []) => {
  const got = addTask(board, { id, title: `任务 ${id}`, blockedBy, now: T });
  if (!got.ok) throw new Error(got.error);
  return got.board;
};

describe("任务与依赖", () => {
  it("⭐ 加任务；依赖必须存在", () => {
    const b0 = createBoard();
    const b1 = add(b0, "a");
    expect(b1.tasks).toHaveLength(1);
    expect(b1.revision).toBe(1);
    const bad = addTask(b1, { id: "b", title: "x", blockedBy: ["不存在"], now: T });
    expect(bad.ok).toBe(false);
  });

  it("⭐ 依赖成环被拒（自己依赖自己 / 传递成环）", () => {
    const b1 = add(createBoard(), "a");
    const self = addTask(b1, { id: "b", title: "x", blockedBy: ["b"], now: T });
    expect(self.ok).toBe(false);

    const b2 = add(b1, "b", ["a"]);
    const back = addTask(b2, { id: "c", title: "x", blockedBy: ["b"], now: T });
    expect(back.ok).toBe(true);
    const b3 = back.ok ? back.board : b2;
    /* a 不能反过来依赖 c（会形成 a→c→b→a） */
    expect(wouldCycle(b3.tasks, "a", ["c"])).toBe(true);
  });

  it("上游没完成 → 不能认领", () => {
    const b = add(add(createBoard(), "a"), "b", ["a"]);
    const got = isClaimable(b, "b");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("a");
  });

  it("上游完成后可认领", () => {
    let b = add(add(createBoard(), "a"), "b", ["a"]);
    b = must(finishTask(b, { taskId: "a", status: "done", now: T }));
    expect(isClaimable(b, "b").ok).toBe(true);
  });
});

function must(result: { ok: true; board: ReturnType<typeof createBoard> } | { ok: false; error: string }) {
  if (!result.ok) throw new Error(result.error);
  return result.board;
}

describe("认领（CAS）", () => {
  it("⭐ 版本不一致 → 冲突，不覆盖", () => {
    let b = add(createBoard(), "a");
    b = must(claimTask(b, { taskId: "a", assignee: "阿洁", revision: 1, now: T }));
    /* 别人还拿着 v1 来认领 */
    const conflict = claimTask(b, { taskId: "a", assignee: "别人", revision: 1, now: T });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toContain("已经变了");
  });

  it("已认领的任务不能被第二个人领", () => {
    let b = add(createBoard(), "a");
    b = must(claimTask(b, { taskId: "a", assignee: "阿洁", revision: 1, now: T }));
    const again = claimTask(b, { taskId: "a", assignee: "别人", revision: 2, now: T });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("已经被");
  });

  it("不可原地改：旧的 board 对象不受影响（调用方能安全持有旧版）", () => {
    const b0 = add(createBoard(), "a");
    const b1 = must(claimTask(b0, { taskId: "a", assignee: "阿洁", revision: 1, now: T }));
    expect(b0.tasks[0]?.status).toBe("open");
    expect(b1.tasks[0]?.status).toBe("claimed");
  });
});

describe("收尾", () => {
  it("只能由认领人收尾（给了 by 时）", () => {
    let b = add(createBoard(), "a");
    b = must(claimTask(b, { taskId: "a", assignee: "阿洁", revision: 1, now: T }));
    expect(finishTask(b, { taskId: "a", status: "done", by: "别人", now: T }).ok).toBe(false);
    expect(finishTask(b, { taskId: "a", status: "done", by: "阿洁", note: "做完了", now: T }).ok).toBe(true);
  });

  it("已收尾的不能再收尾（幂等失败，不静默成功）", () => {
    let b = add(createBoard(), "a");
    b = must(finishTask(b, { taskId: "a", status: "failed", note: "炸了", now: T }));
    expect(finishTask(b, { taskId: "a", status: "done", now: T }).ok).toBe(false);
  });
});

describe("信箱", () => {
  it("⭐ 按人隔离；ack 之后不再出现", () => {
    let b = createBoard();
    b = must(postMessage(b, { from: "阿洁", to: "小明", text: "帮我看下", now: T }));
    b = must(postMessage(b, { from: "阿洁", to: "小红", text: "另一件", now: T + 1 }));
    expect(inboxOf(b, "小明").map((m) => m.text)).toEqual(["帮我看下"]);
    expect(inboxOf(b, "小红").map((m) => m.text)).toEqual(["另一件"]);

    const id = inboxOf(b, "小明")[0]!.id;
    b = must(ackMessages(b, "小明", [id]));
    expect(inboxOf(b, "小明")).toEqual([]);
    /* 别人的不受影响 */
    expect(inboxOf(b, "小红")).toHaveLength(1);
  });

  it("不能 ack 别人的留言", () => {
    let b = must(postMessage(createBoard(), { from: "阿洁", to: "小明", text: "x", now: T }));
    const id = inboxOf(b, "小明")[0]!.id;
    expect(ackMessages(b, "小红", [id]).ok).toBe(false);
  });

  it("空留言被拒", () => {
    expect(postMessage(createBoard(), { from: "a", to: "b", text: "  " }).ok).toBe(false);
  });
});

describe("摘要", () => {
  it("按状态计数 + 可认领清单", () => {
    let b = add(add(add(createBoard(), "a"), "b", ["a"]), "c");
    b = must(claimTask(b, { taskId: "c", assignee: "阿洁", revision: 1, now: T }));
    const s = boardSummary(b);
    /* a 开放且可认领；b 被 a 挡着（开放）；c 已被领 */
    expect(s).toMatchObject({ open: 2, claimed: 1, done: 0, failed: 0 });
    expect(s.claimable).toEqual(["a"]);
  });
});
