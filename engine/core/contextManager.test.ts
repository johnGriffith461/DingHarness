import { describe, expect, it } from "vitest";

import { estimateTokens } from "./context";
import {
  CONTEXT_INDEX_MAX_ITEMS,
  MAX_COMPACTIONS_BEFORE_INDEX,
  buildContextIndex,
  classifyClaim,
  contextIndexTokens,
  decideContext,
  indexFitsBudget,
  renderContextIndex,
  type ContextSignals,
} from "./contextManager";

/**
 * ICM 裁决器（V6-1c）。
 *
 * 这条测试的重点不是"函数返回了什么"，而是**两种最容易被摘要骗过去的状态**：
 *   ① 用户说"谢谢"但测试还在跑；
 *   ② 模型说"已完成"但只做了一半。
 * 它们必须走 `fork_index`（保留活的执行状态），而不是 `compact`（压成要点）。
 */

const base: ContextSignals = {
  tokens: 30_000,
  keepTokens: 20_000,
  pendingWork: false,
  openItems: 0,
  failedTools: 0,
  runningChecks: false,
  claim: "other",
  evidenceComplete: true,
  compactions: 0,
  hasFreshIndex: false,
};

describe("口径分类", () => {
  it("中文与英文的关键口径都认得", () => {
    expect(classifyClaim("谢谢，辛苦了")).toBe("thanks");
    expect(classifyClaim("已经完成了")).toBe("done");
    expect(classifyClaim("正在跑测试")).toBe("progress");
    expect(classifyClaim("thanks, all done")).toBe("done"); // done 优先于 thanks
    expect(classifyClaim("the tests are still running")).toBe("progress");
    expect(classifyClaim("再来一轮")).toBe("other");
    expect(classifyClaim("")).toBe("other");
  });
});

describe("裁决：活状态优先", () => {
  it("未超额度 → keep（不管别的信号）", () => {
    expect(decideContext({ ...base, tokens: 100 }).action).toBe("keep");
  });

  it("⭐ 用户说谢谢但测试在跑 → fork_index（不许当收尾压掉）", () => {
    const d = decideContext({ ...base, claim: "thanks", runningChecks: true });
    expect(d.action).toBe("fork_index");
    expect(d.reason).toContain("检查");
  });

  it("⭐ 模型说完成但还有待办 → fork_index（假完成）", () => {
    const d = decideContext({ ...base, claim: "done", openItems: 2 });
    expect(d.action).toBe("fork_index");
    expect(d.reason).toContain("2 项");
  });

  it("模型说完成、证据也确实完整 → compact", () => {
    expect(decideContext({ ...base, claim: "done", evidenceComplete: true }).action).toBe("compact");
  });

  it("有工具在等审批 → fork_index", () => {
    expect(decideContext({ ...base, pendingWork: true }).action).toBe("fork_index");
  });

  it("有工具失败没处理 → fork_index", () => {
    expect(decideContext({ ...base, failedTools: 1 }).action).toBe("fork_index");
  });

  it(`压过 ${MAX_COMPACTIONS_BEFORE_INDEX} 次还没有索引 → fork_index（不许压摘要的摘要）`, () => {
    const d = decideContext({ ...base, compactions: MAX_COMPACTIONS_BEFORE_INDEX });
    expect(d.action).toBe("fork_index");
    expect(d.reason).toContain("摘要的摘要");
  });

  it("已有新鲜索引 → 可以 compact", () => {
    expect(decideContext({ ...base, compactions: 5, hasFreshIndex: true }).action).toBe("compact");
  });
});

describe("索引", () => {
  const index = buildContextIndex({
    sessionId: "task-42",
    goal: "把 demo 里的 md 整理成纪要",
    decisions: ["只用本地文件", "不要联网"],
    openItems: ["第四节还没写", "等用户确认标题"],
    artifacts: ["纪要.md"],
    atSeq: 120,
    eventCount: 340,
    createdAt: 1_700_000_000_000,
  });

  it("渲染出目标/已定/未完成/产物/锚点，并明确说它是索引不是细节", () => {
    const text = renderContextIndex(index);
    expect(text).toContain("【上下文索引（不是摘要）】");
    expect(text).toContain("目标：把 demo 里的 md 整理成纪要");
    expect(text).toContain("- 只用本地文件");
    expect(text).toContain("- 等用户确认标题");
    expect(text).toContain("- 纪要.md");
    expect(text).toContain("事件序号 120（共 340 条）");
    expect(text).toContain("关键事实请用工具核实");
  });

  it("没目标时不编一个（写成未记录并提示）", () => {
    const empty = buildContextIndex({ sessionId: "s", goal: "  " });
    expect(empty.goal).toBe("（未记录目标）");
    expect(renderContextIndex(empty)).toContain("目标：（未记录目标）");
  });

  it("条目去重、去空、截条数（索引不许长成日志）", () => {
    const many = Array.from({ length: 30 }, (_, i) => `第 ${i} 条`);
    const built = buildContextIndex({ sessionId: "s", goal: "g", decisions: ["重复", "重复", " ", ...many] });
    expect(built.decisions).toHaveLength(CONTEXT_INDEX_MAX_ITEMS);
    expect(built.decisions[0]).toBe("重复");
  });

  it("索引 token 与 `context.ts` 的计量同一把尺", () => {
    expect(contextIndexTokens(index)).toBe(estimateTokens(renderContextIndex(index)));
  });

  it("预算检查：额度内为真、超了为假", () => {
    const tokens = contextIndexTokens(index);
    expect(indexFitsBudget(index, tokens)).toBe(true);
    expect(indexFitsBudget(index, tokens - 1)).toBe(false);
  });
});

/**
 * V6-4b「永不遗忘的会话」：跨 10 次压缩/切会话之后，**目标还在**。
 *
 * 这条不测"模型记不记得"（那要真模型），测的是产品承诺的**机制**：
 *   ① 活状态触发的是 `fork_index` 而不是 `compact`；
 *   ② 索引从事件流事实重建，目标与未完成项逐次带过去；
 *   ③ 索引不会随轮次无限膨胀（有上限）。
 */
describe("跨 10 次压缩/切换后的目标保持（V6-4b）", () => {
  const GOAL = "把 12 份季度报表合并成一份年度纪要，最后跑一遍校验";

  it("每次有活状态都选 fork_index；索引里的目标十轮后一字不差", () => {
    let openItems = 3;
    let compactions = 0;
    const seenGoals = new Set<string>();
    const seenOpen: string[] = [];

    for (let round = 1; round <= 10; round += 1) {
      const decision = decideContext({
        ...base,
        tokens: 30_000 + round * 1000,
        openItems,
        /* 第 5 轮假装"说完成了但只做一半" —— 必须仍然走索引 */
        claim: round === 5 ? "done" : "progress",
        evidenceComplete: false,
        compactions,
        hasFreshIndex: round > 1,
      });
      expect(decision.action, `第 ${round} 轮该走索引`).toBe("fork_index");

      const index = buildContextIndex({
        sessionId: "task-long",
        goal: GOAL,
        openItems: [`第 ${round} 节还没写`, ...Array.from({ length: openItems - 1 }, (_, i) => `待办 ${round}-${i}`)],
        decisions: [`第 ${round} 轮定的口径`],
        atSeq: round * 100,
        eventCount: round * 137,
      });
      seenGoals.add(index.goal);
      seenOpen.push(...index.openItems);
      /* 索引不会随轮次无限膨胀 */
      expect(index.openItems.length).toBeLessThanOrEqual(CONTEXT_INDEX_MAX_ITEMS);

      /* 切到"新会话"：把渲染出来的索引带过去 —— 目标必须仍在里面 */
      const carried = renderContextIndex(index);
      expect(carried).toContain(GOAL);

      compactions += 1;
      openItems = Math.max(1, openItems - 1);
    }

    expect(seenGoals).toEqual(new Set([GOAL]));
    expect(seenOpen.length).toBeGreaterThan(10);
  });

  it("任务真正收尾（没有活状态）后才允许 compact —— 不是为了压缩而压缩", () => {
    const decision = decideContext({
      ...base,
      tokens: 50_000,
      openItems: 0,
      failedTools: 0,
      runningChecks: false,
      pendingWork: false,
      claim: "done",
      evidenceComplete: true,
      compactions: 2,
      hasFreshIndex: true,
    });
    expect(decision.action).toBe("compact");
  });
});
