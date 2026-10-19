import { describe, expect, it } from "vitest";

import { normalizeTaskSessionId, bareTaskId } from "./sessionId";

/**
 * T-01：任务会话 id 的**唯一**归一化函数。
 *
 * 缺陷形状（WorkBuddy 实测）：
 * - 工作台对话的事件写在**裸任务 id** 下（`runStream` 原样传 `taskId`）；
 * - 审批决策与改动审阅写在 **`task-<taskId>`** 下（`taskSessionId`）；
 * 于是同一任务的两类记录落在两个会话里：
 * 审批表永远 pending（UPDATE 匹配不到）、审阅永远为空（读的会话里没有工具结果）。
 */
describe("normalizeTaskSessionId", () => {
  it("裸 id 加 task- 前缀", () => {
    expect(normalizeTaskSessionId("1")).toBe("task-1");
    expect(normalizeTaskSessionId("tmvabc")).toBe("task-tmvabc");
  });

  it("已带前缀不重复加", () => {
    expect(normalizeTaskSessionId("task-1")).toBe("task-1");
    expect(normalizeTaskSessionId("task-task-1")).toBe("task-task-1");
  });

  it("空串原样返回（不造一个 task- 空会话）", () => {
    expect(normalizeTaskSessionId("")).toBe("");
    expect(normalizeTaskSessionId("   ")).toBe("");
  });
});

describe("bareTaskId", () => {
  it("带前缀去掉，裸 id 原样", () => {
    expect(bareTaskId("task-1")).toBe("1");
    expect(bareTaskId("1")).toBe("1");
    expect(bareTaskId("")).toBe("");
  });
});
