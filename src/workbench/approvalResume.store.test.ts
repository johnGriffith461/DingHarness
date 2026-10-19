import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P0-05：审批续跑的**接线**（store 层）。
 *
 * 这里把 `continueWithUserMessage` 换成探针 —— 那一步会真调模型，
 * 不是这个用例要测的；要测的是"批几次、续几次、续跑消息里有什么"。
 */
const continueCalls: string[] = [];
vi.mock("./taskRuntime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./taskRuntime")>();
  return {
    ...actual,
    continueWithUserMessage: vi.fn(async (_port: unknown, _taskId: string, text: string) => {
      continueCalls.push(text);
    }),
  };
});

import { useWorkbenchStore } from "./store";
import { resetApprovalResumeState } from "./approvalResume";
import type { ToolTrace } from "@shared/agentTools";

function trace(id: string, name = "write_file"): ToolTrace {
  return { toolCallId: id, name, input: { path: `${id}.md` }, line: "⚙ 等你确认", pending: true, ok: false };
}

function seed(traces: ToolTrace[]) {
  useWorkbenchStore.setState({
    tasks: [
      {
        id: "t1",
        title: "任务",
        brief: "干活",
        createdAt: 0,
        stage: "done",
        startedAt: 0,
        finishedAt: null,
        steps: [{ id: "s1", role: "assistant", text: "…", at: 0, tools: traces }],
        questions: [],
        questionIndex: 0,
        activity: "",
        artifacts: [],
      },
    ],
    activeTaskId: "t1",
    runningRequestId: null,
  } as unknown as Parameters<typeof useWorkbenchStore.setState>[0]);
}

beforeEach(() => {
  continueCalls.length = 0;
  resetApprovalResumeState();
  (globalThis as unknown as { shell?: unknown }).shell = {
    ai: {
      runTool: async (req: { reject?: boolean }) => ({
        ok: true,
        line: req.reject ? "⚙ 写文件：你已拒绝" : "⚙ 已写入",
      }),
    },
  };
});

describe("P0-05：审批后继续", () => {
  it("批准三次 → 三个 pending 全部处置，只续一次，消息里三条结果", async () => {
    seed([trace("c1"), trace("c2"), trace("c3")]);
    const n = await useWorkbenchStore.getState().resolveAllTools("t1", "s1", true);
    expect(n).toBe(3);
    expect(continueCalls).toHaveLength(1);
    /* 三条结果都在同一条消息里（按 name 计数，不依赖工具调用 id 进文案） */
    expect(continueCalls[0]?.match(/- write_file: ok/g)).toHaveLength(3);
  });

  it("拒绝一次 → 续跑消息里写「用户拒绝」且提示不要重复", async () => {
    seed([trace("c1")]);
    await useWorkbenchStore.getState().resolveTool("t1", "s1", "c1", false);
    expect(continueCalls).toHaveLength(1);
    expect(continueCalls[0]).toContain("用户拒绝");
    expect(continueCalls[0]).toContain("不要重复");
  });

  it("同一 step 第 4 次续跑被预算拦下（不续第 4 次）", async () => {
    const { clearResumeFired } = await import("./approvalResume");
    for (let i = 1; i <= 4; i += 1) {
      seed([trace(`c${i}`)]);
      /* 清"这一批已续"标记，但**保留**预算计数 —— 模拟同一 step 的四批审批 */
      clearResumeFired("t1", "s1");
      await useWorkbenchStore.getState().resolveTool("t1", "s1", `c${i}`, true);
    }
    /* 前三次续了，第四次被预算拦下 */
    expect(continueCalls).toHaveLength(3);
  });
});
