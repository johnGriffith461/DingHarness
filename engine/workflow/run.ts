import type { ConfirmMode } from "../../shared/ipc";
import { runTeam, type MakeTools } from "../runtime/team";
import { taskWithUpstream, type StepState, type WorkflowRun } from "./types";

/**
 * 工作流执行器（V6-2l）。
 *
 * ## 一层一层跑，每层一次 `runTeam`
 *
 * 同一层里互不依赖的步骤**并行**（runTeam 本来就是并行）；层与层之间有依赖，
 * 上一层全部收尾（或被跳过）才轮到下一层。上游的摘要会拼进下游的任务描述 ——
 * "先调研、再实现"里，实现那一步真的看得到调研结果。
 *
 * ## 检查点
 *
 * 每次状态变化都 `onCheckpoint`（CLI 落盘）。中断只把状态标成 `paused`，
 * 已经 `done` 的步骤不会被重跑。
 */

export type WorkflowDeps = {
  provider: string;
  model?: string;
  /** 调用方档位（步骤只能更严，规则在 `resolveAgentMode`）。 */
  callerMode: ConfirmMode;
  makeTools: MakeTools;
  signal?: AbortSignal;
  /** 每次检查点（落盘用；同步函数，不 await）。 */
  onCheckpoint?: (run: WorkflowRun) => void;
  /** 运行结束/暂停后回调（与 checkpoint 同一个形状，便于界面即时更新）。 */
  onUpdate?: (run: WorkflowRun) => void;
  /** 恢复时把上次失败的步骤重新排上（默认不重试）。 */
  retryFailed?: boolean;
  now?: () => number;
  /**
   * 执行一层的实现（默认 `runTeam`）。
   *
   * 只为测试留的口子：工作流编排（依赖/泳道/检查点）不该为了可测而绑上真模型。
   */
  runStage?: typeof runTeam;
};

/** 这一步是不是"永远轮不到"（依赖失败/被跳过）。 */
function blockedByFailure(step: StepState, run: WorkflowRun): boolean {
  return step.dependsOn.some((dep) => {
    const upstream = run.steps.find((s) => s.id === dep);
    return upstream?.status === "failed" || upstream?.status === "skipped";
  });
}

/**
 * 跑一份工作流（可传入已存在的运行用于续跑）。
 *
 * @param run 运行状态（新建或从检查点恢复）
 * @param deps 依赖
 * @returns 结束时的运行状态（done/failed/paused）
 */
export async function runWorkflow(run: WorkflowRun, deps: WorkflowDeps): Promise<WorkflowRun> {
  const now = deps.now ?? Date.now;
  const checkpoint = () => {
    run.updatedAt = now();
    deps.onCheckpoint?.(run);
    deps.onUpdate?.(run);
  };

  if (deps.retryFailed) {
    for (const step of run.steps) {
      if (step.status === "failed") {
        step.status = "pending";
        step.error = undefined;
      }
      if (step.status === "skipped") {
        step.status = "pending";
      }
    }
  }
  run.status = "running";
  checkpoint();

  for (;;) {
    if (deps.signal?.aborted) {
      /* 中断：只把"正在跑"的放回 pending（不判失败），状态落 paused */
      for (const step of run.steps) if (step.status === "running") step.status = "pending";
      run.status = "paused";
      checkpoint();
      return run;
    }

    /* 依赖失败/跳过的步骤：级联跳过（它们永远不会满足条件） */
    let changed = false;
    for (const step of run.steps) {
      if (step.status === "pending" && blockedByFailure(step, run)) {
        step.status = "skipped";
        step.error = "上游失败或被跳过";
        changed = true;
      }
    }
    if (changed) checkpoint();

    const pending = run.steps.filter((s) => s.status === "pending");
    if (!pending.length) {
      const failed = run.steps.filter((s) => s.status === "failed").length;
      run.status = failed ? "failed" : "done";
      if (failed) run.error = `${failed} 个步骤失败（已按依赖跳过无法继续的那些）`;
      checkpoint();
      return run;
    }

    const ready = pending.filter((step) =>
      step.dependsOn.every((dep) => run.steps.find((s) => s.id === dep)?.status === "done"),
    );
    if (!ready.length) {
      run.status = "failed";
      run.error = "有步骤永远等不到依赖（成环或依赖不存在）";
      checkpoint();
      return run;
    }

    const startedAt = now();
    for (const step of ready) {
      step.status = "running";
      step.startedAt = startedAt;
    }
    checkpoint();

    const report = await (deps.runStage ?? runTeam)({
      tasks: ready.map((step) => ({ agent: step.agent, task: taskWithUpstream(step, run) })),
      provider: deps.provider,
      ...(deps.model ? { model: deps.model } : {}),
      callerMode: deps.callerMode,
      makeTools: deps.makeTools,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });

    if (deps.signal?.aborted) {
      for (const step of ready) step.status = "pending";
      run.status = "paused";
      checkpoint();
      return run;
    }

    const finishedAt = now();
    ready.forEach((step, index) => {
      const member = report.members[index];
      step.finishedAt = finishedAt;
      if (member?.ok) {
        step.status = "done";
        step.summary = member.summary;
        step.steps = member.steps;
        if (member.usage) step.usage = member.usage;
      } else {
        step.status = "failed";
        step.error = member?.error ?? "没有拿到这一步的结果";
        step.steps = member?.steps;
      }
    });
    checkpoint();
  }
}
