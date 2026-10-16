import { beforeEach, describe, expect, it } from "vitest";
import { useWorkbenchStore } from "./store";
import type { ToolTrace } from "@shared/agentTools";

/**
 * 同一次工具调用不许被处置两遍（2026-10-16 审计 P48）。
 *
 * ## 缺陷形状
 *
 * 「允许 / 拒绝」那两颗键原来是裸的 `onClick`，而 `runToolOnce` 是**真在主进程干活**的
 * （写文件、跑命令、装插件）。连点两下、或者界面上两个入口同时点，
 * 同一个副作用就执行两遍 —— 而"装两遍插件"这种后果是不可逆的。
 *
 * 界面侧现在会禁用（`ToolTraceList` 的"执行中…"），但**收口必须在这里**：
 * 界面禁用拦不住绕过界面的调用。判据：并发调两次 `resolveTool`，主进程只该被调一次。
 */

function fakeBridge() {
  let calls = 0;
  const bridge = {
    ai: {
      runTool: async () => {
        calls += 1;
        // 让第一次挂在飞行中：这正是"用户等不及又点了一下"的那一刻
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, line: "⚙ 已执行" };
      },
    },
  };
  return { bridge, calls: () => calls };
}

const pendingTrace = (): ToolTrace => ({
  toolCallId: "c1",
  name: "write_file",
  input: { path: "a.md" },
  line: "⚙ 等你确认",
  pending: true,
  ok: false,
});

function seed() {
  useWorkbenchStore.setState({
    tasks: [
      {
        id: "t1",
        title: "任务",
        brief: "干点活",
        createdAt: 0,
        stage: "done",
        startedAt: 0,
        finishedAt: null,
        steps: [{ id: "s1", role: "assistant", text: "…", at: 0, tools: [pendingTrace()] }],
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
  seed();
});

describe("P48：并发放行只执行一次", () => {
  it("⭐ 连点两下「允许」→ 主进程只被调一次", async () => {
    const fake = fakeBridge();
    (globalThis as unknown as { shell?: unknown }).shell = fake.bridge;

    const resolve = useWorkbenchStore.getState().resolveTool;
    await Promise.all([resolve("t1", "s1", "c1", true), resolve("t1", "s1", "c1", true)]);

    expect(fake.calls(), "同一次调用被执行了两遍 —— 副作用（写文件/装插件）真的发生了两次").toBe(1);
  });

  it("⭐ 已经处置过（pending 落成 false）之后再来一次 → 不再执行", async () => {
    const fake = fakeBridge();
    (globalThis as unknown as { shell?: unknown }).shell = fake.bridge;

    await useWorkbenchStore.getState().resolveTool("t1", "s1", "c1", true);
    expect(fake.calls()).toBe(1);
    /* 界面上那颗键此刻已经没了，但"绕过界面"的调用不该还能再跑一遍 */
    await useWorkbenchStore.getState().resolveTool("t1", "s1", "c1", true);
    expect(fake.calls(), "pending 已经是 false 还照跑 —— 这就是「同一次副作用执行两遍」").toBe(1);
  });

  it("拒绝也走同一道闸（拒绝同样要上报主进程，同样只许一次）", async () => {
    const fake = fakeBridge();
    (globalThis as unknown as { shell?: unknown }).shell = fake.bridge;
    await Promise.all([
      useWorkbenchStore.getState().resolveTool("t1", "s1", "c1", false),
      useWorkbenchStore.getState().resolveTool("t1", "s1", "c1", false),
    ]);
    expect(fake.calls()).toBe(1);
  });

  it("处置完之后那条 trace 上的 pending 落成 false（界面据此收起两颗键）", async () => {
    const fake = fakeBridge();
    (globalThis as unknown as { shell?: unknown }).shell = fake.bridge;
    await useWorkbenchStore.getState().resolveTool("t1", "s1", "c1", true);
    const trace = useWorkbenchStore.getState().tasks[0]!.steps[0]!.tools![0]!;
    expect(trace.pending).toBe(false);
    expect(trace.ok).toBe(true);
  });
});
