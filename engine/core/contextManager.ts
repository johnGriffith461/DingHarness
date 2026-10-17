/**
 * ICM：上下文管理裁决器（V6-1c）。
 *
 * ## 它解决的是什么
 *
 * 原来的压缩是**无条件摘要**：历史一过额度就压，压完继续跑。这在"任务已经收尾"
 * 时没问题；在"任务正跑到一半"时是**丢状态**——摘要刻意只留"决定/数字/约束/未完成"，
 * 而"第 3 个测试还在跑、刚才那次写入失败了"这类**活的执行状态**会被抹掉。
 * 模型于是会"重新开始"或者报告一个假完成。
 *
 * ## 两条出路，不是一条
 *
 * | 动作 | 什么时候 | 代价 |
 * |---|---|---|
 * | `compact` | 旧内容确实可以压成要点，任务没有活状态 | 一次摘要调用（有 token 成本） |
 * | `fork_index` | 有工具在跑/待审批、有待办、有失败、或"声称完成但证据不足" | **0 次模型调用**：从事件流生成索引 |
 *
 * `fork_index` 之所以"无损"，是因为事件溯源内核把**完整历史留在 append-only 日志**里
 * （`engine/core/events.ts` 的 fold/replay/fork）。索引只是下一次请求的**接力棒**，
 * 不是对历史的改写——任何时刻都能按锚点回放核对。
 *
 * ## 对抗口径
 *
 * 两个最容易骗过摘要的状态：
 *   · 用户说"谢谢"但测试还在跑（`thanks` + `runningChecks`）；
 *   · 模型说"已完成"但只做了一半（`done` + 证据不足）。
 * 这两种都判 `fork_index`。`classifyClaim` + `contradictsClaim` 就是这条的尺子。
 */

import { estimateTokens } from "./context";

/** 索引格式版本（改结构必须升版本；旧索引按版本回落）。 */
export const CONTEXT_INDEX_VERSION = 1;

/** 连续压缩到这个次数还没有索引 → 强制切索引（防止"压了又压"把任务压丢）。 */
export const MAX_COMPACTIONS_BEFORE_INDEX = 3;

/** 索引里每一类最多带几条（再多就不是索引，是日志了）。 */
export const CONTEXT_INDEX_MAX_ITEMS = 12;

/** 单条索引文字的上限（挡住"把整段话抄进索引"）。 */
export const CONTEXT_INDEX_ITEM_MAX_CHARS = 160;

/** 最近一条助手回复的口径。 */
export type ClaimKind = "done" | "thanks" | "progress" | "other";

/**
 * 从一句话里认口径（中文优先，英文兜底）。
 *
 * ⚠️ 它只做**分类**，不做真假判断；真假由 `decideContext` 拿证据判。
 */
export function classifyClaim(text: string): ClaimKind {
  const t = String(text ?? "").trim();
  if (!t) return "other";
  /*
   * **完成口径优先于感谢**：`"thanks, all done"` 里真正需要被验证的是"done"。
   * 先认感谢会把"假完成"放过去（它只被当成一句客套）。
   */
  if (/(已完成|完成了|搞定了|做好了|都做完了|全部完成|\bdone\b|\bfinished\b|\bcompleted\b)/i.test(t)) return "done";
  if (/(谢谢|感谢|辛苦了|多谢|thanks|thank you)/i.test(t)) return "thanks";
  if (/(正在|还在|继续|进行中|跑着|仍在|\brunning\b|\bin progress\b|\bworking on\b)/i.test(t)) return "progress";
  return "other";
}

/** 裁决需要的信号（全部是**已经发生的事实**，不是模型自述）。 */
export type ContextSignals = {
  /** 这次准备发的历史估算 token。 */
  tokens: number;
  /** 保留额度。 */
  keepTokens: number;
  /** 有工具在等审批/正在执行。 */
  pendingWork: boolean;
  /** 还有没做完的事（待办/未答问题/未完成步骤）。 */
  openItems: number;
  /** 最近的工具调用失败数。 */
  failedTools: number;
  /** 有检查/测试在跑。 */
  runningChecks: boolean;
  /** 最近一条助手回复的口径。 */
  claim: ClaimKind;
  /** 当模型声称"完成"时，证据是否也指向完成（无待办/无失败/无在跑）。 */
  evidenceComplete: boolean;
  /** 这一段会话已经压过几次。 */
  compactions: number;
  /** 是否已有新鲜的索引可用。 */
  hasFreshIndex: boolean;
};

/** 裁决结果。 */
export type ContextDecision =
  | { action: "keep"; reason: string }
  | { action: "compact"; reason: string }
  | { action: "fork_index"; reason: string };

/**
 * "声称完成"与证据是否矛盾。
 *
 * @param claim 口径
 * @param signals 事实信号
 * @returns 矛盾返回一句人能读的原因；不矛盾返回 null
 */
export function contradictsClaim(claim: ClaimKind, signals: Pick<ContextSignals, "openItems" | "failedTools" | "runningChecks" | "pendingWork">): string | null {
  if (claim !== "done") return null;
  if (signals.openItems > 0) return `它说完成了，但还有 ${signals.openItems} 项没做完`;
  if (signals.failedTools > 0) return `它说完成了，但有 ${signals.failedTools} 次工具调用失败`;
  if (signals.runningChecks) return "它说完成了，但检查/测试还在跑";
  if (signals.pendingWork) return "它说完成了，但还有工具在等审批/执行";
  return null;
}

/**
 * 裁决：该保留、该压缩，还是该切索引。
 *
 * @param s 信号
 * @returns 动作 + 一句原因（原因会进日志/界面，别写成内部术语）
 */
export function decideContext(s: ContextSignals): ContextDecision {
  const over = s.tokens > s.keepTokens;
  if (!over) {
    return { action: "keep", reason: `历史 ${s.tokens} token，未超过额度 ${s.keepTokens}` };
  }

  /*
   * 活状态优先：只要还有**未收场的东西**，就不许摘要。
   * 顺序按"最容易骗过人"的排：先看自称完成但证据不足，再看别的。
   */
  const contradiction = contradictsClaim(s.claim, s);
  if (contradiction) return { action: "fork_index", reason: contradiction };
  if (s.pendingWork) return { action: "fork_index", reason: "还有工具在等审批/执行，摘要会把活的执行状态抹掉" };
  if (s.openItems > 0) return { action: "fork_index", reason: `还有 ${s.openItems} 项没做完，摘要会丢任务目标` };
  if (s.failedTools > 0) return { action: "fork_index", reason: `最近有 ${s.failedTools} 次工具失败没处理，摘要会把它们抹平` };
  if (s.runningChecks) return { action: "fork_index", reason: "检查/测试还在跑，现在摘要会把结果丢掉" };

  /*
   * 反复压缩：摘要的摘要会逐轮丢细节。到阈值就换索引接力
   * （索引从事件流重建，不依赖上一份摘要）。
   */
  if (s.compactions >= MAX_COMPACTIONS_BEFORE_INDEX && !s.hasFreshIndex) {
    return { action: "fork_index", reason: `已经压过 ${s.compactions} 次，再压就是摘要的摘要` };
  }
  if (s.hasFreshIndex) return { action: "compact", reason: "已有新鲜索引；旧正文可以压成要点" };
  return { action: "compact", reason: "任务已收尾且没有活状态，可以压成要点" };
}

/** 建索引的输入（全部来自宿主已有的数据，**不额外调模型**）。 */
export type ContextIndexInput = {
  sessionId: string;
  /** 任务目标（一句话）。 */
  goal: string;
  /** 已定下来的事（决定/约束/数字）。 */
  decisions?: readonly string[];
  /** 未完成的事。 */
  openItems?: readonly string[];
  /** 这次任务产出的文件/链接。 */
  artifacts?: readonly string[];
  /** 锚点：截到哪个事件序号（回放用）。 */
  atSeq?: number;
  /** 锚点处的事件条数。 */
  eventCount?: number;
  /** 生成时间（毫秒）。 */
  createdAt?: number;
};

/** 可持久化、可回放核对的上下文索引。 */
export type ContextIndex = {
  version: number;
  sessionId: string;
  goal: string;
  decisions: string[];
  openItems: string[];
  artifacts: string[];
  anchor: { seq: number; eventCount: number };
  createdAt: number;
};

/** 把一条文字收进索引：去空白、截断、去重。 */
function tidy(text: string): string {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > CONTEXT_INDEX_ITEM_MAX_CHARS ? `${one.slice(0, CONTEXT_INDEX_ITEM_MAX_CHARS - 1)}…` : one;
}

/** 去空、去重、截条数（保持原顺序）。 */
function take(items: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items ?? []) {
    const text = tidy(raw);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= CONTEXT_INDEX_MAX_ITEMS) break;
  }
  return out;
}

/**
 * 生成索引。
 *
 * ⚠️ `goal` 为空时**不编一个**：写成「（未记录目标）」并在渲染时提示先确认。
 * 编出来的目标比没有目标更坏 —— 模型会沿着一个假目标一路跑下去。
 */
export function buildContextIndex(input: ContextIndexInput): ContextIndex {
  return {
    version: CONTEXT_INDEX_VERSION,
    sessionId: input.sessionId,
    goal: tidy(input.goal) || "（未记录目标）",
    decisions: take(input.decisions),
    openItems: take(input.openItems),
    artifacts: take(input.artifacts),
    anchor: {
      seq: Math.max(0, Math.floor(input.atSeq ?? 0)),
      eventCount: Math.max(0, Math.floor(input.eventCount ?? 0)),
    },
    createdAt: input.createdAt ?? Date.now(),
  };
}

/** 渲染成给模型看的一段（明确说"这是索引，不是细节来源"）。 */
export function renderContextIndex(index: ContextIndex): string {
  const lines: string[] = ["【上下文索引（不是摘要）】", `目标：${index.goal}`];
  if (index.decisions.length) {
    lines.push("已定：");
    for (const item of index.decisions) lines.push(`- ${item}`);
  }
  if (index.openItems.length) {
    lines.push("未完成：");
    for (const item of index.openItems) lines.push(`- ${item}`);
  }
  if (index.artifacts.length) {
    lines.push("产物：");
    for (const item of index.artifacts) lines.push(`- ${item}`);
  }
  lines.push(
    `锚点：会话 ${index.sessionId}，事件序号 ${index.anchor.seq}（共 ${index.anchor.eventCount} 条）—— 可用回放核对。`,
  );
  lines.push("⚠️ 索引只记要点，不是全部细节；关键事实请用工具核实，不要凭印象续写。");
  return lines.join("\n");
}

/**
 * 索引的估算 token（复用 `estimateTokens` 的口径，不另起一套）。
 *
 * @param index 索引
 * @returns 估算 token
 */
export function contextIndexTokens(index: ContextIndex): number {
  /*
   * 计量**只用** `context.ts` 那一份实现：上下文管理里出现两把尺，
   * "该不该压"的判定就会与"实际留了多少"对不上（本仓踩过：两把尺让判据失真）。
   */
  return estimateTokens(renderContextIndex(index));
}

/** 索引是否在给定额度内（超了就说明"索引本身变成负担"了）。 */
export function indexFitsBudget(index: ContextIndex, maxTokens: number): boolean {
  return contextIndexTokens(index) <= Math.max(0, maxTokens);
}
