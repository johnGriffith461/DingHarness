/**
 * 跨进程只读视图的形状（从 shared/ipc.ts 拆出来，2026-10-17）。
 *
 * 拆的理由只是结构守卫（ipc.ts 撞了 900 行上限）；内容与语义一个字没改。
 */

export type TurnTraceView = {
  sessionId: string;
  title: string;
  requestId: string;
  at: number;
  provider: string;
  model: string;
  elapsedMs?: number;
  input: number;
  output: number;
  ok: boolean;
  toolCalls: number;
  /** 其中失败了几次（工具报错或被执行体拒绝）。L08 加的；老数据没有就当 0。 */
  toolFailures?: number;
  error?: string;
};

/** 用量桶（天 × 模型）。 */
export type UsageBucketView = {
  day: string;
  model: string;
  input: number;
  output: number;
  turns: number;
};

/** 用量汇总（V6-2d）：90 天窗口、按天与按模型两个切面。 */
export type UsageSummaryView = {
  since: number;
  totals: { input: number; output: number; turns: number };
  byDay: { day: string; input: number; output: number; turns: number }[];
  byModel: { model: string; input: number; output: number; turns: number }[];
  rows: UsageBucketView[];
};

/** 工作流定义摘要（V6-2l 的产品面）。 */
export type WorkflowSpecView = {
  file: string;
  name: string;
  steps: number;
  valid: boolean;
  errors?: string[];
};

/** 工作流运行的一步（与 `engine/workflow/types.ts` 同形，界面只读）。 */
export type WorkflowStepView = {
  id: string;
  agent: string;
  task: string;
  dependsOn: string[];
  status: "pending" | "running" | "done" | "failed" | "skipped";
  summary?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
};

/** 一次工作流运行（界面只读）。 */
export type WorkflowRunView = {
  id: string;
  name: string;
  specFile?: string;
  status: "running" | "paused" | "done" | "failed";
  createdAt: number;
  updatedAt: number;
  steps: WorkflowStepView[];
  error?: string;
};

