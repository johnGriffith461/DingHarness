import { describe, expect, it } from "vitest";

import {
  CHEAP_PRICE_IN,
  LONG_CONTEXT_THRESHOLD,
  MODEL_GROUPS,
  UNKNOWN_CONTEXT_ESTIMATE,
  capabilityOf,
  describeCapability,
  formatPrice,
  groupCatalog,
  groupsOf,
  recommendReason,
} from "./modelCatalog";
import { allProviders } from "./providers";

/**
 * 模型能力表（D03）。
 *
 * 挡三件事：
 * ① 未登记模型**不混进推荐**（审计原话："7 个未登记模型还混在推荐里"）；
 * ② 五种窗口输入（1M / 400k / 200k / 32k / 未知）都能给出能力记录，且"估计"要标出来；
 * ③ 价格缺失时显示"未知"，不是 $0（$0 会让人以为免费）。
 */

describe("能力记录（capabilityOf）", () => {
  it("⭐ 1M 模型：登记过、窗口是实测值、不是估计", () => {
    const cap = capabilityOf("deepseek-flash");
    expect(cap.registered).toBe(true);
    expect(cap.estimated).toBe(false);
    expect(cap.contextWindow).toBe(1_000_000);
    expect(groupsOf(cap)).toContain("长上下文");
  });

  it("⭐ 未登记模型：窗口是 200k 的**估计**，不是 1M、也不是 20k", () => {
    const cap = capabilityOf("deepseek-reasoner");
    expect(cap.registered).toBe(false);
    expect(cap.estimated).toBe(true);
    expect(cap.contextWindow).toBe(UNKNOWN_CONTEXT_ESTIMATE);
    expect(cap.contextWindow).not.toBe(1_000_000);
  });

  it("登记过的模型带来源、核实日期与过期标记字段", () => {
    const cap = capabilityOf("deepseek-chat");
    expect(cap.source).toBe("builtin");
    expect(cap.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof cap.stale).toBe("boolean");
  });

  it("自定义 provider 的模型标成 custom（不冒充内置目录）", () => {
    const cap = capabilityOf("deepseek-chat", { provider: "my-relay", source: "custom" });
    expect(cap.source).toBe("custom");
    expect(cap.provider).toBe("deepseek"); // 目录里的原生 provider 仍然如实
  });

  it("读图模态从目录能力推导（没有 modalities 字段的旧条目也能用）", () => {
    const cap = capabilityOf("gpt-4o-mini");
    expect(cap.modalities).toContain("image");
    expect(groupsOf(cap)).toContain("读图");
  });

  it("输出上限没有核实就不写（不编一个看起来合理的数）", () => {
    expect(capabilityOf("deepseek-flash").outputLimit).toBeUndefined();
  });
});

describe("分组（groupsOf / groupCatalog）", () => {
  it("⭐ 未登记模型**只**进「未登记」（不混进推荐/编码/便宜）", () => {
    const cap = capabilityOf("qwen-max");
    expect(groupsOf(cap)).toEqual(["未登记"]);
  });

  it("⭐ provider 表里恰好 7 个未登记模型 —— 它们全在「未登记」组，推荐组里一个都没有", () => {
    const ids = new Set<string>();
    for (const provider of allProviders()) for (const model of provider.models) ids.add(model);
    const caps = [...ids].map((id) => capabilityOf(id));
    const unregistered = caps.filter((c) => !c.registered);
    expect(unregistered.map((c) => c.id).sort()).toEqual(
      ["claude-3-5-sonnet", "deepseek-reasoner", "deepseek-v3", "gemini-3.1-pro-preview", "gemini-3.5-flash", "qwen-max", "qwen-turbo"].sort(),
    );
    const recommended = caps.filter((c) => groupsOf(c).includes("推荐"));
    expect(recommended.every((c) => c.registered), "推荐里混进了未登记模型").toBe(true);
  });

  it("阈值口径可复核：长上下文 ≥ 200k、便宜 ≤ $0.30 输入价", () => {
    expect(LONG_CONTEXT_THRESHOLD).toBe(200_000);
    expect(CHEAP_PRICE_IN).toBe(0.3);
    const flash = capabilityOf("deepseek-flash");
    expect(flash.priceIn).toBeLessThanOrEqual(CHEAP_PRICE_IN);
    expect(groupsOf(flash)).toEqual(expect.arrayContaining(["推荐", "便宜", "长上下文"]));
  });

  it("推荐组每条都有**理由**（进推荐要能回答「凭什么」）", () => {
    const caps = ["deepseek-flash", "deepseek-chat", "gpt-4o-mini", "claude-sonnet-4-5"].map((id) => capabilityOf(id));
    for (const cap of caps) expect(recommendReason(cap.id), cap.id).toBeTruthy();
    expect(recommendReason("qwen-plus")).toBeUndefined();
  });

  it("分组顺序固定、空组不出现", () => {
    const groups = groupCatalog([capabilityOf("deepseek-flash")]).map((g) => g.group);
    expect(groups[0]).toBe("推荐");
    for (const g of groups) expect(MODEL_GROUPS).toContain(g);
    expect(groupCatalog([])).toEqual([]);
  });
});

describe("给人看的那句话（describeCapability）", () => {
  it("登记过：窗口 / 保留 / 价格 / 能力都在", () => {
    const line = describeCapability(capabilityOf("deepseek-flash"));
    expect(line).toContain("1,000,000");
    expect(line).toContain("$0.150");
    expect(line).toContain("工具");
    expect(line).toContain("思考");
  });

  it("⭐ 未登记：明说「估计」与「未登记」，不把 200k 说成实测", () => {
    const line = describeCapability(capabilityOf("deepseek-reasoner"));
    expect(line).toContain("（估计）");
    expect(line).toContain("未登记");
    expect(line).toContain("价格未记录");
  });

  it("价格缺失显示「未知」而不是 $0（$0 会让人以为免费）", () => {
    expect(formatPrice(undefined)).toBe("未知");
    expect(formatPrice(0.003)).toBe("$0.003");
    expect(formatPrice(1.5)).toBe("$1.50");
  });
});
