import type { ConfirmMode } from "../../shared/ipc";

/**
 * 多 agent 工作流的定义与运行状态（V6-2l）。
 *
 * ## 与"团队"的关系
 *
 * `runTeam` 是**一层并行**：一组专家同时干活、汇合。工作流是**有依赖的层**：
 * 上一层的结果喂给下一层（先调研 → 再实现 → 再审阅）。实现上工作流**复用** `runTeam`，
 * 每一层就是一次 `runTeam` —— 工具/闸门/委派那一整套不重写。
 *
 * ## 断点续跑
 *
 * 每一层结束就落一次检查点（`WorkflowRun`）。中断（Ctrl+C / 关窗）只把状态标成
 * `paused`；`--resume` 从**没做完的层**继续（已完成的步骤不重跑）。
 */

/** 工作流里的一个步骤。 */
export type WorkflowStep = {
  /** 稳定 id（依赖用）。 */
  id: string;
  /** 内置专家名（`engine/runtime/agents.ts` 里的那批）。 */
  agent: string;
  /** 这一步要做什么（会拼上上游的摘要）。 */
  task: string;
  /** 依赖的步骤 id（全部完成才轮到自己）。 */
  dependsOn?: string[];
};

/** 一份工作流定义。 */
export type WorkflowSpec = {
  name: string;
  description?: string;
  /** 步骤（依赖必须指向存在的 id；不许成环）。 */
  steps: WorkflowStep[];
  /** 闸门档位（默认按需确认；步骤只能更严）。 */
  mode?: ConfirmMode;
};

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** 运行时的一步。 */
export type StepState = {
  id: string;
  agent: string;
  task: string;
  dependsOn: string[];
  status: StepStatus;
  summary?: string;
  error?: string;
  steps?: number;
  startedAt?: number;
  finishedAt?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
};

/** 一次运行（可直接落盘当检查点）。 */
export type WorkflowRun = {
  /** 运行 id（`wf-<时间>-<随机>`）。 */
  id: string;
  name: string;
  /** 定义文件（给人看"这是哪份"）。 */
  specFile?: string;
  status: "running" | "paused" | "done" | "failed";
  createdAt: number;
  updatedAt: number;
  steps: StepState[];
  error?: string;
};

/** 从定义建一份新运行。 */
export function newRun(spec: WorkflowSpec, opts: { id: string; specFile?: string; now?: number }): WorkflowRun {
  const now = opts.now ?? Date.now();
  return {
    id: opts.id,
    name: spec.name,
    ...(opts.specFile ? { specFile: opts.specFile } : {}),
    status: "running",
    createdAt: now,
    updatedAt: now,
    steps: spec.steps.map((step) => ({
      id: step.id,
      agent: step.agent,
      task: step.task,
      dependsOn: [...(step.dependsOn ?? [])],
      status: "pending",
    })),
  };
}

/**
 * 校验定义。
 *
 * @returns 错误说明（空 = 合法）
 */
export function validateWorkflow(spec: WorkflowSpec): string[] {
  const errors: string[] = [];
  if (!String(spec.name ?? "").trim()) errors.push("缺 name");
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    errors.push("steps 必须是非空数组");
    return errors;
  }
  const ids = new Set<string>();
  for (const step of spec.steps) {
    if (!String(step.id ?? "").trim()) errors.push("有步骤缺 id");
    else if (ids.has(step.id)) errors.push(`步骤 id 重复：${step.id}`);
    else ids.add(step.id);
    if (!String(step.agent ?? "").trim()) errors.push(`${step.id}：缺 agent`);
    if (!String(step.task ?? "").trim()) errors.push(`${step.id}：缺 task`);
  }
  for (const step of spec.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) errors.push(`${step.id} 依赖了不存在的步骤：${dep}`);
      if (dep === step.id) errors.push(`${step.id} 不能依赖自己`);
    }
  }
  /* 环检测（DFS 三色） */
  const color = new Map<string, 0 | 1 | 2>();
  const byId = new Map(spec.steps.map((s) => [s.id, s]));
  const visit = (id: string, path: string[]): void => {
    const state = color.get(id) ?? 0;
    if (state === 2) return;
    if (state === 1) {
      errors.push(`依赖成环：${[...path, id].join(" → ")}`);
      return;
    }
    color.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...path, id]);
    color.set(id, 2);
  };
  for (const step of spec.steps) visit(step.id, []);
  return [...new Set(errors)];
}

/**
 * 把"上游结果"拼进这一步的任务描述。
 *
 * @param step 步骤
 * @param run 运行（用来找上游 summary）
 */
export function taskWithUpstream(step: StepState, run: WorkflowRun): string {
  if (!step.dependsOn.length) return step.task;
  const parts: string[] = [];
  for (const dep of step.dependsOn) {
    const upstream = run.steps.find((s) => s.id === dep);
    if (!upstream?.summary) continue;
    parts.push(`[${dep}] ${upstream.summary}`);
  }
  return parts.length ? `${step.task}\n\n上游结果：\n${parts.join("\n\n")}` : step.task;
}

/** 状态中文名（界面/CLI 共用一份）。 */
export const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "等待",
  running: "进行中",
  done: "完成",
  failed: "失败",
  skipped: "跳过",
};
