import { describe, expect, it } from "vitest";

import type { TeamReport } from "../runtime/team";
import { runWorkflow } from "./run";
import { newRun, taskWithUpstream, validateWorkflow, type WorkflowSpec } from "./types";

/**
 * 工作流编排（V6-2l）。
 *
 * 测的是**依赖与泳道**，不是模型：`runStage` 注入一个假执行器，
 * 断言"哪些步骤在同一层并行、下游拿不拿得到上游摘要、失败怎么级联、续跑会不会重跑已完成的"。
 */

const spec: WorkflowSpec = {
  name: "周报流水线",
  steps: [
    { id: "research", agent: "researcher", task: "收集本周数据" },
    { id: "design", agent: "architect", task: "给出大纲" },
    { id: "write", agent: "writer", task: "写成周报", dependsOn: ["research", "design"] },
    { id: "review", agent: "reviewer", task: "审阅", dependsOn: ["write"] },
  ],
};

/** 假执行器：按顺序给每个 task 一个摘要；可指定某些 agent 失败。 */
function fakeStage(opts: { fail?: string[] } = {}) {
  const stages: string[][] = [];
  const seenTasks: string[] = [];
  const stage = async (input: { tasks: readonly { agent: string; task: string }[] }): Promise<TeamReport> => {
    stages.push(input.tasks.map((t) => t.agent));
    seenTasks.push(...input.tasks.map((t) => t.task));
    const members = input.tasks.map((task) => {
      const failed = opts.fail?.includes(task.agent) ?? false;
      return {
        agent: task.agent,
        task: task.task,
        ok: !failed,
        summary: failed ? "" : `${task.agent} 的结果`,
        steps: 2,
        toolCalls: [],
        blocked: [],
        ...(failed ? { error: `${task.agent} 失败了` } : {}),
      };
    });
    return {
      ok: members.every((m) => m.ok),
      summary: "汇总",
      members,
      blocked: [],
      failed: members.filter((m) => !m.ok).length,
    };
  };
  return { stage, stages, seenTasks };
}

const deps = (stage: ReturnType<typeof fakeStage>) => ({
  provider: "fake",
  callerMode: "按需确认" as const,
  makeTools: (() => ({}) as never) as never,
  runStage: stage.stage as never,
});

describe("定义校验", () => {
  it("缺字段 / 依赖不存在 / 自依赖 / 成环都报出来", () => {
    expect(validateWorkflow(spec)).toEqual([]);
    const bad: WorkflowSpec = {
      name: "",
      steps: [
        { id: "a", agent: "x", task: "t", dependsOn: ["b"] },
        { id: "b", agent: "y", task: "t", dependsOn: ["a"] },
        { id: "a", agent: "z", task: "" },
        { id: "c", agent: "x", task: "t", dependsOn: ["nope", "c"] },
      ],
    };
    const errors = validateWorkflow(bad).join("\n");
    expect(errors).toContain("缺 name");
    expect(errors).toContain("id 重复");
    expect(errors).toContain("缺 task");
    expect(errors).toContain("不存在的步骤");
    expect(errors).toContain("不能依赖自己");
    expect(errors).toContain("成环");
  });
});

describe("执行与泳道", () => {
  it("⭐ 同一层并行、下一层拿得到上游摘要", async () => {
    const run = newRun(spec, { id: "r1", now: 1000 });
    const fake = fakeStage();
    const done = await runWorkflow(run, deps(fake));

    expect(done.status).toBe("done");
    /* 第 1 层：research + design 并行；第 2 层 write；第 3 层 review */
    expect(fake.stages).toEqual([["researcher", "architect"], ["writer"], ["reviewer"]]);
    const writeTask = fake.seenTasks.find((t) => t.includes("写成周报"))!;
    expect(writeTask).toContain("[research] researcher 的结果");
    expect(writeTask).toContain("[design] architect 的结果");
    /* 已完成的步骤带着摘要 */
    expect(done.steps.find((s) => s.id === "write")?.summary).toBe("writer 的结果");
  });

  it("⭐ 上游失败：下游级联跳过，整体 failed（不会假装跑完）", async () => {
    const run = newRun(spec, { id: "r2", now: 1000 });
    const fake = fakeStage({ fail: ["architect"] });
    const done = await runWorkflow(run, deps(fake));

    expect(done.status).toBe("failed");
    expect(done.steps.find((s) => s.id === "design")?.status).toBe("failed");
    expect(done.steps.find((s) => s.id === "write")?.status).toBe("skipped");
    expect(done.steps.find((s) => s.id === "review")?.status).toBe("skipped");
    /* 不重跑失败的步骤：design 只跑了一次 */
    expect(fake.stages.flat().filter((a) => a === "architect")).toHaveLength(1);
  });

  it("续跑：已 done 的步骤不重跑，只补没做完的", async () => {
    const run = newRun(spec, { id: "r3", now: 1000 });
    const fake = fakeStage();
    await runWorkflow(run, deps(fake));
    /* 人为退回一半：write/review 变 pending（模拟在中途崩了/暂停了） */
    run.steps.find((s) => s.id === "write")!.status = "pending";
    run.steps.find((s) => s.id === "review")!.status = "pending";
    run.status = "paused";
    const before = fake.stages.length;

    const done = await runWorkflow(run, deps(fake));
    expect(done.status).toBe("done");
    /* 只补了 write/review 两层；research/design 没重跑 */
    expect(fake.stages.slice(before)).toEqual([["writer"], ["reviewer"]]);
  });

  it("检查点：每一步状态变化都会回调（落盘用）", async () => {
    const run = newRun(spec, { id: "r4", now: 1000 });
    let checkpoints = 0;
    const fake = fakeStage();
    await runWorkflow(run, { ...deps(fake), onCheckpoint: () => (checkpoints += 1) });
    expect(checkpoints).toBeGreaterThan(5);
  });

  it("任务拼接：没有上游摘要就不硬加一段空话", () => {
    const run = newRun(spec, { id: "r5" });
    const step = run.steps.find((s) => s.id === "write")!;
    expect(taskWithUpstream(step, run)).toBe("写成周报");
    run.steps.find((s) => s.id === "research")!.summary = "调研结果";
    expect(taskWithUpstream(step, run)).toContain("上游结果");
  });
});
