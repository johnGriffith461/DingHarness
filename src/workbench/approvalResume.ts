/**
 * P0-05：审批之后**把结果送回模型**并继续。
 *
 * ## 修的是什么
 *
 * `resolveTool` 原来只执行命令、改那一行留痕，然后就结束了 —— 模型那一轮早就
 * `done` 了，它永远不知道用户批了什么、执行结果是什么。界面上看是"批准了但没动静"。
 *
 * 现在：同一 step 的待批项**全部处置完**之后，把这一批结果整理成一条 user 消息，
 * 用 `answerTurn` 续跑一轮。批量批准只续一次；同一个 step 最多续 3 次。
 */

import type { ToolTrace } from "@shared/agentTools";

/** 一次审批的结局（来自执行体或"用户拒绝"）。 */
export type ApprovalOutcome = {
  toolCallId?: string;
  name: string;
  /** 用户拒绝了这次调用（没有执行）。 */
  rejected?: boolean;
  ok: boolean;
  output?: unknown;
  error?: string;
};

/** 一条结果压成一句可读的话（给模型看，也给用户看）。 */
function lineOf(result: ApprovalOutcome): string {
  if (result.rejected) return `${result.name}: 【用户拒绝】不要重复这个调用，换方法或说明卡点`;
  if (result.ok) {
    const text =
      result.output && typeof result.output === "object"
        ? ((result.output as { text?: unknown; line?: unknown }).text ??
          (result.output as { line?: unknown }).line)
        : result.output;
    const detail = typeof text === "string" ? text.trim().slice(0, 800) : "";
    return `${result.name}: ok${detail ? ` —— ${detail}` : ""}`;
  }
  return `${result.name}: error —— ${(result.error ?? "没有说明原因").slice(0, 800)}`;
}

/**
 * 把一批审批结果整理成一条 user 消息。
 *
 * 口径：批准写 `ok/error`（错误也照抄，模型要知道），拒绝写"用户拒绝"。
 */
export function buildApprovalResultMessage(results: readonly ApprovalOutcome[]): string {
  const rejected = results.filter((r) => r.rejected).length;
  const head = rejected
    ? `【用户拒绝】${rejected} 个调用被拒绝；其余结果如下。不要重复被拒绝的调用。`
    : "【工具执行结果】";
  return [
    head,
    ...results.map((r) => `- ${lineOf(r)}`),
    "",
    "请根据这些结果继续完成原任务：不要重复已经执行过的调用；被拒绝的调用换一种方法，或说明卡在哪。",
  ].join("\n");
}

/** 这个 step 还有没有没处置的待批项。 */
export function hasPendingApproval(traces: readonly ToolTrace[]): boolean {
  return traces.some((t) => t.pending === true);
}

/**
 * 同一 step 的续跑预算（模块级、按 `taskId/stepId` 计数）。
 *
 * 上限 3：模型如果反复要审批（同样的动作），继续续跑只会烧钱不前进。
 */
const resumed = new Map<string, number>();
export const MAX_APPROVAL_RESUMES = 3;

/** 这次还允许续跑吗（并记账）。 */
export function takeResumeBudget(taskId: string, stepId: string): boolean {
  const key = `${taskId}/${stepId}`;
  const used = resumed.get(key) ?? 0;
  if (used >= MAX_APPROVAL_RESUMES) return false;
  resumed.set(key, used + 1);
  return true;
}

/** 测试用：清空预算与"已续"标记。 */
export function resetApprovalResumeState(): void {
  resumed.clear();
  fired.clear();
}

/** 这一批是否已经续过一次（同 step 的多个结果只续一次）。 */
const fired = new Set<string>();
export function markResumeFired(taskId: string, stepId: string): boolean {
  const key = `${taskId}/${stepId}`;
  if (fired.has(key)) return false;
  fired.add(key);
  return true;
}

/** 测试/新一轮用：允许这个 step 再次续跑（收到新的用户消息后调用）。 */
export function clearResumeFired(taskId: string, stepId: string): void {
  fired.delete(`${taskId}/${stepId}`);
}
