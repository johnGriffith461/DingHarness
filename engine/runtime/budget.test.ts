import { describe, expect, it } from "vitest";

import { KEEP_RECENT_TOKENS } from "../core/context";
import { KEEP_RECENT_TOKENS_MIN, MAX_KEEP_TOKENS, budgetOf, describeBudget, keepTokensFor } from "./budget";
import { MODEL_CATALOG, type ModelSpec } from "./models";

/**
 * 上下文预算策略（Phase 5.1 收敛后：这个文件只管「给多少」，不管「数据是什么」）。
 *
 * ## 这组断言挡的是什么
 *
 * 上下文额度直接乘在**每一轮的钱**上。所以这里盯两件相反的事：
 * ① 未登记模型**零漂移**（还是换代前那个固定值）；
 * ② 登记过的大上限模型**不许**把额度一路放大（那是静默的成本变化）。
 */

/** 临时塞一条进表（测完就撤）。 */
function withModel(spec: ModelSpec, run: () => void): void {
  const table = MODEL_CATALOG as ModelSpec[];
  table.push(spec);
  try {
    run();
  } finally {
    table.pop();
  }
}

const makeSpec = (id: string, contextWindow: number): ModelSpec => ({
  id,
  provider: "p",
  protocol: "openai-compatible",
  contextWindow,
  capabilities: { toolCall: true },
  source: "https://example.com",
  verifiedAt: "2026-10-15",
});

describe("保留额度（keepTokensFor）", () => {
  it("⭐ 未登记模型 = 换代前那个固定值（**零漂移**，这是刻意的）", () => {
    expect(keepTokensFor("deepseek-reasoner")).toBe(KEEP_RECENT_TOKENS);
    expect(keepTokensFor(undefined)).toBe(KEEP_RECENT_TOKENS);
  });

  it("⭐ 登记过的大上限模型**封顶**在同一额度上（不静默把每轮成本放大）", () => {
    /*
     * deepseek-flash 的上限是 1M。若真按「上限 × 一半」留历史，就是每轮
     * 重发 50 万 token —— **单轮成本 ×25**，而且没人会注意到是这次改的。
     */
    expect(keepTokensFor("deepseek-flash")).toBe(MAX_KEEP_TOKENS);
    expect(MAX_KEEP_TOKENS).toBe(KEEP_RECENT_TOKENS);
  });

  it("上限**小**的模型会少留一点（这一半是立刻生效的：别顶爆）", () => {
    withModel(makeSpec("tiny-test", 8000), () => {
      expect(keepTokensFor("tiny-test")).toBe(4000);
      expect(keepTokensFor("tiny-test")).toBeLessThan(KEEP_RECENT_TOKENS);
    });
  });

  it("小到离谱也不低于下限（防止「额度小到等于没有」）", () => {
    withModel(makeSpec("absurd-test", 100), () => {
      expect(keepTokensFor("absurd-test")).toBe(KEEP_RECENT_TOKENS_MIN);
    });
  });

  it("⭐ 下限**不许**盖掉「小模型少留一点」（第一版就是被它盖掉的）", () => {
    // 上限 8K 的模型按一半算应当是 4K。若下限设成 8000，这里会得到 8000 —— 每轮顶爆。
    expect(KEEP_RECENT_TOKENS_MIN).toBeLessThan(KEEP_RECENT_TOKENS);
  });
});

describe("查预算（budgetOf）", () => {
  it("未登记是一等结果（不是 undefined）", () => {
    expect(budgetOf("deepseek-reasoner")).toEqual({ registered: false, contextWindow: 20_000, stale: false });
  });

  it("登记过：带上限与过期标记", () => {
    const got = budgetOf("deepseek-flash");
    expect(got.registered).toBe(true);
    expect(got.contextWindow).toBe(1_000_000);
    expect(got.stale).toBe(false);
  });
});

describe("给人看的那句话（describeBudget）", () => {
  it("未登记：明说「未登记模型」与保守默认", () => {
    const line = describeBudget("deepseek-reasoner");
    expect(line).toContain("未登记模型");
    expect(line).toContain(String(KEEP_RECENT_TOKENS));
  });

  it("登记过：带上限、来源，以及**我们按多少留**（否则用户无从判断为什么不是满额）", () => {
    const line = describeBudget("deepseek-flash");
    expect(line).toContain("1000000");
    expect(line).toContain("封顶");
    expect(line).toContain(String(MAX_KEEP_TOKENS));
  });
});
