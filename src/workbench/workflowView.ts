import type { WorkflowStepView } from "@shared/ipc";

/**
 * 工作流泳道的**可渲染形状**（V6-2l）。
 *
 * 按依赖分层：第一层是没有依赖的步骤，第二层是依赖都在第一层里的……
 * 同一层并行、层与层串行 —— 界面照这个画列，用户一眼能看出"卡在哪一层"。
 *
 * ⚠️ 成环/依赖不存在时不会死循环：认不出的步骤落到最后一层并标注（如实显示，不隐藏）。
 */

export type WorkflowLayer = {
  index: number;
  steps: WorkflowStepView[];
};

/**
 * 把步骤按依赖分层。
 *
 * @param steps 运行里的步骤
 * @returns 层（顺序 = 执行顺序）
 */
export function layersOf(steps: readonly WorkflowStepView[]): WorkflowLayer[] {
  const ids = new Set(steps.map((s) => s.id));
  const placed = new Set<string>();
  const layers: WorkflowLayer[] = [];
  let remaining = [...steps];

  while (remaining.length) {
    const ready = remaining.filter((step) => step.dependsOn.every((dep) => !ids.has(dep) || placed.has(dep)));
    if (!ready.length) {
      /* 成环/坏依赖：剩下的全放最后一层（界面标红由状态决定，不假装解析成功） */
      layers.push({ index: layers.length, steps: remaining });
      break;
    }
    layers.push({ index: layers.length, steps: ready });
    for (const step of ready) placed.add(step.id);
    remaining = remaining.filter((step) => !placed.has(step.id));
  }
  return layers;
}

/** 运行进度（完成/总数；跳过与失败不算完成）。 */
export function progressOf(steps: readonly WorkflowStepView[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.status === "done").length, total: steps.length };
}

/** 续跑命令（界面只展示，不执行）。 */
export function resumeCommand(runId: string, dir: string): string {
  return `ding workflow run --resume "${dir}/runs/${runId}.json"`;
}
