import { describe, expect, it } from "vitest";

import { KEEP_RECENT_TOKENS } from "../core/context";
import {
  KEEP_RECENT_TOKENS_MIN,
  MODEL_CATALOG,
  MAX_KEEP_TOKENS,
  STALE_DAYS,
  budgetOf,
  describeBudget,
  isStale,
  keepTokensFor,
  type ModelBudget,
} from "./budget";

/**
 * 模型目录表与预算（Phase 1 D4）。
 *
 * ## 这组断言挡的是什么
 *
 * 一个"这个模型能装多少"的数字，最坏的失效不是偏小，是**看起来精确**：
 * 后面所有"这段历史该不该压"的判断都会建在它上面，而它错了没有任何东西会报。
 * 所以这里有三类断言：
 * ① 未登记模型**绝不**被安上一个数字（走保守默认）；
 * ② 表里的每条都必须带来源与核实日期（否则它凭什么算"核实过"）；
 * ③ 保留额度**封顶**（往上跟着模型放大等于静默把每轮成本乘几十倍）。
 */

describe("查表", () => {
  it("⭐ 未登记模型：`registered: false`（是一等结果，不是 undefined）", () => {
    expect(budgetOf("deepseek-chat")).toEqual({ registered: false, stale: false });
    expect(budgetOf(undefined)).toEqual({ registered: false, stale: false });
    expect(budgetOf("编出来的模型名")).toEqual({ registered: false, stale: false });
  });

  it("登记过的模型：给得出上限与来源", () => {
    const found = budgetOf("deepseek-flash");
    expect(found.registered).toBe(true);
    expect(found.registered && found.model.contextWindow).toBe(1_000_000);
    expect(found.registered && found.model.source).toContain("api-docs.deepseek.com");
  });
});

describe("表本身的质量（这几条是「这张表能不能被信任」的前提）", () => {
  it("⭐ 每一条都带 `source` 与 `verifiedAt`（没有来源的条目不许进表）", () => {
    for (const m of MODEL_CATALOG) {
      expect(m.source, `${m.id} 没有来源`).toMatch(/^https?:\/\//);
      expect(m.verifiedAt, `${m.id} 没有核实日期`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.contextWindow, `${m.id} 的上限应当是正数`).toBeGreaterThan(0);
    }
  });

  it("id 不重复（重复会让查表结果取决于顺序）", () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("过期", () => {
  const entry: ModelBudget = {
    id: "x",
    contextWindow: 1000,
    source: "https://example.com",
    verifiedAt: "2026-01-01",
  };

  it("超过保质期就算过期", () => {
    const day = 86_400_000;
    const fresh = Date.parse("2026-01-01T00:00:00Z") + (STALE_DAYS - 1) * day;
    const old = Date.parse("2026-01-01T00:00:00Z") + (STALE_DAYS + 1) * day;
    expect(isStale(entry, fresh)).toBe(false);
    expect(isStale(entry, old)).toBe(true);
  });

  it("日期读不懂 → 当作过期（宁可标出来，不要静默沿用）", () => {
    expect(isStale({ ...entry, verifiedAt: "哪天来着" })).toBe(true);
  });

  it("过期的条目会在说明里明说（而不是安静地用）", () => {
    const old = Date.parse("2027-06-01T00:00:00Z");
    expect(describeBudget("deepseek-flash", old)).toContain("可能过期");
  });
});

describe("保留额度（keepTokensFor）", () => {
  it("⭐ 未登记模型 = 换代前那个固定值（**零漂移**，这是刻意的）", () => {
    expect(keepTokensFor("deepseek-chat")).toBe(KEEP_RECENT_TOKENS);
    expect(keepTokensFor(undefined)).toBe(KEEP_RECENT_TOKENS);
  });

  it("⭐ 登记过的大上限模型**封顶**在同一额度上（不静默把每轮成本放大）", () => {
    /*
     * deepseek-flash 的上限是 1M。若真按"上限 × 一半"留历史，就是每轮
     * 重发 50 万 token —— **单轮成本 ×25**，而且没人会注意到是这次改的。
     * 所以往上封顶，想放开是个明示的决定。
     */
    expect(keepTokensFor("deepseek-flash")).toBe(MAX_KEEP_TOKENS);
    expect(MAX_KEEP_TOKENS).toBe(KEEP_RECENT_TOKENS);
  });

  it("上限**小**的模型会少留一点（这一半是立刻生效的：别顶爆）", () => {
    // 临时往表里塞一个 8K 上限的模型（测完就撤）—— 真实表里没有这种小模型
    const table = MODEL_CATALOG as ModelBudget[];
    table.push({ id: "tiny-test", contextWindow: 8000, source: "https://example.com", verifiedAt: "2026-10-14" });
    try {
      expect(keepTokensFor("tiny-test")).toBe(4000);
      expect(keepTokensFor("tiny-test")).toBeLessThan(KEEP_RECENT_TOKENS);
    } finally {
      table.pop();
    }
  });

  it("小到离谱也不低于下限（防止「额度小到等于没有」）", () => {
    const table = MODEL_CATALOG as ModelBudget[];
    table.push({ id: "absurd-test", contextWindow: 100, source: "https://example.com", verifiedAt: "2026-10-14" });
    try {
      expect(keepTokensFor("absurd-test")).toBe(2000);
    } finally {
      table.pop();
    }
  });

  it("⭐ 下限**不许**盖掉「小模型少留一点」（第一版就是被它盖掉的）", () => {
    // 上限 8K 的模型按一半算应当是 4K。若下限设成 8000，这里会得到 8000 —— 每轮顶爆。
    expect(KEEP_RECENT_TOKENS_MIN).toBeLessThan(KEEP_RECENT_TOKENS);
  });
});

describe("给人看的那句话（describeBudget）", () => {
  it("未登记：明说「未登记模型」与「按保守默认」，别让人以为我们不知道还硬算", () => {
    const line = describeBudget("deepseek-chat");
    expect(line).toContain("未登记模型");
    expect(line).toContain(String(KEEP_RECENT_TOKENS));
  });

  it("登记过：带上限、价格、核实日期与来源", () => {
    const line = describeBudget("deepseek-flash");
    expect(line).toContain("1000000");
    expect(line).toContain("2026-10-14");
    expect(line).toContain("api-docs.deepseek.com");
    expect(line).toContain("$0.15");
  });
});
