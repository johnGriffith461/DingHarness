import { describe, expect, it } from "vitest";

import { KEEP_RECENT_TOKENS } from "../core/context";
import {
  BUDGET_MODE_LABEL,
  CONTEXT_BUFFER,
  DEFAULT_CONTEXT_BUDGET,
  ECONOMY_KEEP_TOKENS,
  KEEP_RATIO,
  OUTPUT_RESERVE_MAX,
  budgetBreakdown,
  budgetOf,
  describeBudget,
  keepForWindow,
  keepTokensFor,
  outputReserveFor,
  parseBudgetMode,
} from "./budget";
import { MODEL_CATALOG, type ModelSpec } from "./models";

/**
 * 上下文预算（D04 重写）。
 *
 * ## 这组断言挡的是什么
 *
 * 产品审计的原话："1M 模型只留 20k"。上一版把 20k 写成**全局上限**，
 * 于是大窗口模型只能用到 2% —— 用户以为买了 1M，实际每轮发两万。
 *
 * 现在盯三件相反的事：
 * ① 大窗口**必须放大**（1M ≥ 900k）；
 * ② 小窗口**不许顶爆**（keep ≤ 窗口 − 输出预留）；
 * ③ 未登记模型**不许拿估计值发请求**（仍然 20k）。
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

const makeSpec = (id: string, contextWindow: number, outputLimit?: number): ModelSpec => ({
  id,
  provider: "p",
  protocol: "openai-compatible",
  contextWindow,
  ...(outputLimit === undefined ? {} : { outputLimit }),
  capabilities: { toolCall: true },
  source: "https://example.com",
  verifiedAt: "2026-10-15",
});

describe("按窗口推导（keepForWindow）", () => {
  it("⭐ 1M 模型不再只留 20k：≥ 900k", () => {
    const keep = keepForWindow(1_000_000);
    expect(keep).toBeGreaterThanOrEqual(900_000);
    // 公式可复核：W − min(输出预留 21k) − buffer 13k
    expect(keep).toBe(1_000_000 - OUTPUT_RESERVE_MAX - CONTEXT_BUFFER);
  });

  it("⭐ 200k 模型 ≥ 150k", () => {
    expect(keepForWindow(200_000)).toBeGreaterThanOrEqual(150_000);
  });

  it("⭐ 小窗口不顶爆：keep 永不越过「窗口 − 输出预留」", () => {
    for (const window of [8_000, 16_000, 32_000, 65_536, 128_000]) {
      const reserve = outputReserveFor(window);
      const keep = keepForWindow(window);
      expect(keep, `窗口 ${window}`).toBeLessThanOrEqual(window - reserve);
      expect(keep, `窗口 ${window} 留了 0`).toBeGreaterThan(0);
    }
  });

  it("32k 模型：托底 20k 会被「窗口 − 预留」压到 16k（不是硬塞 20k）", () => {
    // reserve = min(32k, 21k, 8k) = 8k；hardCap = 24k；floor = 16k；raw = 11k
    expect(keepForWindow(32_000)).toBe(16_000);
  });

  it("8k 模型：留一半（4k），给输出留够", () => {
    expect(keepForWindow(8_000)).toBe(4_000);
  });

  it("小到离谱也不越过窗口（100 token → 50）", () => {
    const keep = keepForWindow(100);
    expect(keep).toBe(50);
    expect(keep).toBeLessThanOrEqual(100);
  });

  it("核过输出上限就用它（不再假设 32k）", () => {
    const reserve = outputReserveFor(1_000_000, 4_096);
    expect(reserve).toBe(4_096);
    expect(keepForWindow(1_000_000, "long", 4_096)).toBe(1_000_000 - 4_096 - CONTEXT_BUFFER);
  });
});

describe("三档（long / balanced / economy）", () => {
  it("默认档位是 long（按窗口推导）", () => {
    expect(DEFAULT_CONTEXT_BUDGET).toBe("long");
    expect(keepForWindow(1_000_000)).toBe(keepForWindow(1_000_000, "long"));
  });

  it("balanced = 窗口的一半；economy = 固定 5 万", () => {
    expect(keepForWindow(1_000_000, "balanced")).toBe(1_000_000 * KEEP_RATIO);
    expect(keepForWindow(1_000_000, "economy")).toBe(ECONOMY_KEEP_TOKENS);
  });

  it("economy 在小窗口上也被「窗口 − 预留」压住（不能写死 5 万顶爆）", () => {
    expect(keepForWindow(32_000, "economy")).toBe(24_000);
    expect(keepForWindow(8_000, "economy")).toBe(6_000);
  });

  it("每档都有中文说明", () => {
    for (const mode of ["long", "balanced", "economy"] as const) {
      expect(BUDGET_MODE_LABEL[mode].length).toBeGreaterThan(0);
    }
  });

  it("磁盘值不可信：只认三个词，其余回落 long", () => {
    expect(parseBudgetMode("balanced")).toBe("balanced");
    expect(parseBudgetMode("economy")).toBe("economy");
    expect(parseBudgetMode("long")).toBe("long");
    expect(parseBudgetMode("BALANCED")).toBe("long");
    expect(parseBudgetMode(undefined)).toBe("long");
    expect(parseBudgetMode(123)).toBe("long");
  });
});

describe("保留额度（keepTokensFor）", () => {
  it("⭐ 未登记模型 = 20k（**不拿估计窗口发请求**，与档位无关）", () => {
    expect(keepTokensFor("deepseek-reasoner")).toBe(KEEP_RECENT_TOKENS);
    expect(keepTokensFor(undefined)).toBe(KEEP_RECENT_TOKENS);
    expect(keepTokensFor("deepseek-reasoner", Date.now(), "balanced")).toBe(KEEP_RECENT_TOKENS);
  });

  it("⭐ 登记过的 1M 模型按窗口留（不再封顶 20k）", () => {
    expect(keepTokensFor("deepseek-flash")).toBeGreaterThanOrEqual(900_000);
  });

  it("档位从参数进来（同一个模型三种结果）", () => {
    const long = keepTokensFor("deepseek-flash", Date.now(), "long");
    const balanced = keepTokensFor("deepseek-flash", Date.now(), "balanced");
    const economy = keepTokensFor("deepseek-flash", Date.now(), "economy");
    expect(long).toBeGreaterThan(balanced);
    expect(balanced).toBeGreaterThan(economy);
    expect(economy).toBe(ECONOMY_KEEP_TOKENS);
  });

  it("窗口很小的模型贴着窗口留（审计 P54 的回归）", () => {
    withModel(makeSpec("absurd-test", 100), () => {
      const window = budgetOf("absurd-test").contextWindow;
      const got = keepTokensFor("absurd-test");
      expect(got).toBeLessThanOrEqual(window);
    });
  });
});

describe("查预算（budgetOf）", () => {
  it("未登记是一等结果（不是 undefined）", () => {
    expect(budgetOf("deepseek-reasoner")).toEqual({ registered: false, contextWindow: 20_000, stale: false });
  });

  it("登记过：带上限、过期标记与输出上限（有才带）", () => {
    const got = budgetOf("deepseek-flash");
    expect(got.registered).toBe(true);
    expect(got.contextWindow).toBe(1_000_000);
    expect(got.stale).toBe(false);
  });
});

describe("给人看的那句话（describeBudget / budgetBreakdown）", () => {
  it("未登记：明说「未登记」与「不按估计窗口发请求」", () => {
    const line = describeBudget("deepseek-reasoner");
    expect(line).toContain("未登记模型");
    expect(line).toContain(String(KEEP_RECENT_TOKENS));
    expect(line).toContain("不按估计窗口发请求");
  });

  it("登记过：窗口 / 输出预留 / 历史 / 档位都在（否则用户无从判断为什么不是满额）", () => {
    const line = describeBudget("deepseek-flash");
    expect(line).toContain("1000000");
    expect(line).toContain("输出预留");
    expect(line).toContain("历史 966000");
    expect(line).toContain("档位 long");
  });

  it("breakdown 的 keep 与 keepTokensFor 同一口径", () => {
    const got = budgetBreakdown("deepseek-flash");
    expect(got.keep).toBe(keepTokensFor("deepseek-flash"));
    expect(got.contextWindow).toBe(1_000_000);
    expect(got.outputReserve).toBe(OUTPUT_RESERVE_MAX);
  });
});

describe("用户声明的窗口（T0 模型能力表单）", () => {
  it("用户声明的窗口优先于目录表", () => {
    const found = budgetOf("deepseek-flash", Date.now(), { contextWindow: 200_000 });
    expect(found.registered).toBe(true);
    expect(found.contextWindow).toBe(200_000);
    expect(found.registered && found.source).toBe("user");
  });

  it("目录表命中时 source 是 catalog（界面要分开显示「你填的」与「我们核过的」）", () => {
    const found = budgetOf("deepseek-flash");
    expect(found.registered && found.source).toBe("catalog");
  });

  it("用户声明的窗口让未登记模型也能按真实窗口跑（这是 T0 的目的）", () => {
    expect(keepTokensFor("完全没登记过的模型")).toBe(KEEP_RECENT_TOKENS);
    expect(keepTokensFor("完全没登记过的模型", Date.now(), "long", { contextWindow: 1_000_000 })).toBeGreaterThanOrEqual(
      900_000,
    );
  });

  it("用户声明的输出上限参与预留计算", () => {
    const withOutput = keepTokensFor("x", Date.now(), "long", { contextWindow: 1_000_000, maxOutputTokens: 64_000 });
    const without = keepTokensFor("x", Date.now(), "long", { contextWindow: 1_000_000 });
    /* 两者都被 OUTPUT_RESERVE_MAX(21k) 压住，所以应当相等 —— 这条守的是"不要因为给了大会话就乱留" */
    expect(withOutput).toBe(without);
  });

  it("说明文字标明来源是用户声明", () => {
    expect(describeBudget("deepseek-flash", Date.now(), "long", { contextWindow: 200_000 })).toContain("用户声明");
  });

  it("0 / 负数的声明不当成有效窗口（回落到目录表或保守默认）", () => {
    expect(budgetOf("deepseek-flash", Date.now(), { contextWindow: 0 }).contextWindow).toBe(1_000_000);
    expect(budgetOf("没登记", Date.now(), { contextWindow: -1 }).registered).toBe(false);
  });
});
