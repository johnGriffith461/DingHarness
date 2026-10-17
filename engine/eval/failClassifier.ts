/**
 * 失败分类器（V6-1d）。
 *
 * ## 为什么要有稳定枚举
 *
 * 评测报告原来只有一句中文 `what`（"事件序列"/"关键文案"…）。它给人看没问题，
 * 但**跨版本聚合**不行：文案改一个字、加一条判据，历史成绩就对不上了。
 * 公开成绩页要回答的是"这一版比上一版差在哪一类"，那必须是机器可比的键。
 *
 * 所以这里把判红点收成一张**封闭表**：每条失败在产生处就打上 `kind`，
 * 报告再按 `kind` 汇总。新增判据必须往表里加一个键（而不是随手写一句新文案）。
 *
 * ## 为什么 `environment` 不在失败分类里
 *
 * "本机回环连不上自己的假 provider"**不是产品失败**（见 `run.ts` 的 `environmentFailure`）。
 * 它由 `EvalCaseResult.environment` 单独计数；把它混进失败分类会让
 * "这台机器抽风"看起来像"产品坏了一类"。
 */

/** 封闭的失败类别（新增判据 = 往这里加一个键）。 */
export const FAILURE_KINDS = [
  /** 事件序列不对：该发生的没发生 / 不该发生的发生了。 */
  "event_sequence",
  /** 用户可见文案里缺少关键内容（回注没到）。 */
  "copy_presentation",
  /** 工具调用无声失败（用例没声明允许失败）。 */
  "tool_silent_failure",
  /** 产物该在不在 / 不该在却在。 */
  "artifact",
  /** 闸门待决状态不对。 */
  "gate",
  /** 委派次数不够。 */
  "delegation",
  /** 期望失败的调用没有按预期失败 / 失败原因不对。 */
  "tool_error_expectation",
  /** 下发给模型的工具清单不对。 */
  "tool_listing",
  /** 步数不够。 */
  "step_budget",
  /** 用量账本缺失。 */
  "ledger",
  /** 用例执行抛异常。 */
  "exception",
  /** 超过单条看门狗。 */
  "watchdog",
  /** 纯函数格子（core）的判据不成立。 */
  "core_check",
  /** 基准任务的**判分命令**没通过（测试挂了 / 退出码不对）。 */
  "bench_command",
  /** 基准任务的**文件判分**不符（该有却没有 / 内容不对）。 */
  "bench_file",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** 给人看的一句话（成绩页与 CLI 共用同一份，不许各处自造）。 */
export const FAILURE_KIND_LABELS: Record<FailureKind, string> = {
  event_sequence: "过程不对（事件序列）",
  copy_presentation: "回注缺失（用户可见文案）",
  tool_silent_failure: "工具无声失败",
  artifact: "产物不对",
  gate: "审批闸门不对",
  delegation: "委派不足",
  tool_error_expectation: "失败原因不对",
  tool_listing: "工具清单不对",
  step_budget: "步数不足",
  ledger: "用量账本缺失",
  exception: "执行异常",
  watchdog: "超时未收场",
  core_check: "核心判据不成立",
  bench_command: "判分命令未通过",
  bench_file: "判分文件不符",
};

/** 稳定排序（报告每次输出顺序一致，diff 才好读）。 */
const ORDER: readonly FailureKind[] = FAILURE_KINDS;

/**
 * 按类别汇总（只列出现过的，键顺序固定）。
 *
 * @param failures 全部失败项
 * @returns `{ 类别: 条数 }`（按 `FAILURE_KINDS` 顺序）
 */
export function summarizeFailures(failures: readonly { kind: FailureKind }[]): Partial<Record<FailureKind, number>> {
  const counts = new Map<FailureKind, number>();
  for (const f of failures) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const out: Partial<Record<FailureKind, number>> = {};
  for (const kind of ORDER) {
    const n = counts.get(kind);
    if (n) out[kind] = n;
  }
  return out;
}

/**
 * 把一份成绩单里的失败按类别汇总成一行字（CLI/成绩页用）。
 *
 * @param byKind 汇总
 * @returns 例：`过程不对（事件序列）×3 · 回注缺失（用户可见文案）×1`
 */
export function describeFailureSummary(byKind: Partial<Record<FailureKind, number>>): string {
  return ORDER.filter((k) => byKind[k])
    .map((k) => `${FAILURE_KIND_LABELS[k]}×${byKind[k]}`)
    .join(" · ");
}
