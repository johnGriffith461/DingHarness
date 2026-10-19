import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-01：契约测试 —— `runStream` 交给 `streamChat` 的 `sessionId` **必须是** `task-` 前缀。
 *
 * 这是 WorkBuddy 抓到的原始 bug 的形状：审批/审阅写 `task-<id>`，对话写裸 id，
 * 于是审批表永远 pending、审阅永远为空。单测在两端用同一个 id 时是绿的，
 * 所以这条**只能**断"发出去的那个 id 到底长什么样"。
 */
const chatCalls: Array<{ provider: string; model: string; sessionId?: string }> = [];

vi.mock("../ai/aiClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/aiClient")>();
  return {
    ...actual,
    streamChat: vi.fn(async (request: { provider: string; model: string; sessionId?: string }) => {
      chatCalls.push({ provider: request.provider, model: request.model, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
      return {
        requestId: "r1",
        abort: () => undefined,
        done: Promise.resolve({ aborted: false }),
      };
    }),
  };
});

import { runStream } from "./taskRuntime";
import type { StorePort } from "./store";

function fakePort(taskId: string): StorePort {
  const state = {
    tasks: [
      {
        id: taskId,
        title: "任务",
        brief: "干活",
        createdAt: 0,
        stage: "running",
        startedAt: 0,
        finishedAt: null,
        steps: [],
        questions: [],
        questionIndex: 0,
        activity: "",
        artifacts: [],
      },
    ],
    activeTaskId: taskId,
    runningRequestId: null,
    view: "task",
  };
  return {
    getState: () => state as never,
    setState: (partial: unknown) => {
      const patch = typeof partial === "function" ? (partial as (s: unknown) => unknown)(state) : partial;
      Object.assign(state, patch as object);
    },
    subscribe: () => () => undefined,
  } as unknown as StorePort;
}

beforeEach(() => {
  chatCalls.length = 0;
});

describe("T-01 会话 id 契约", () => {
  it("裸任务 id → streamChat 收到 task-<id>", async () => {
    await runStream(fakePort("1"), "你好", "system", () => undefined, [], "1");
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]?.sessionId).toBe("task-1");
  });

  it("已带前缀的 id 不会变成 task-task-<id>", async () => {
    await runStream(fakePort("task-1"), "你好", "system", () => undefined, [], "task-1");
    expect(chatCalls[0]?.sessionId).toBe("task-1");
  });

  it("空会话 id 不产生 task- 空会话", async () => {
    await runStream(fakePort("x"), "你好", "system", () => undefined, [], "");
    expect(chatCalls[0]?.sessionId).toBeUndefined();
  });
});
