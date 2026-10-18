import { describe, expect, it } from "vitest";

import {
  builtinModelConfigRules,
  configSourceLabel,
  escapeRegex,
  resolveFor,
  resolveUserOnly,
} from "./modelConfigResolver";
import type { ModelConfigRule } from "./modelConfig";

/**
 * 规则来源与解析（T0）。
 *
 * 这里守的是"**用户声明的窗口真的会赢**"——如果推荐规则赢过手动规则，
 * 用户填了 1M 还是按目录里的值跑，而他没有任何办法查明原因。
 */

const input = { providerId: "tokenrhythm", modelId: "deepseek-v4.1-flash-1017", baseUrl: "https://tokenrhythm.studio/v1" };

describe("内置推荐", () => {
  it("目录表里的模型有窗口（来自我们核过的表）", () => {
    const rules = builtinModelConfigRules();
    const resolved = resolveFor({ providerId: "deepseek", modelId: "deepseek-flash", baseUrl: "https://api.deepseek.com" });
    expect(resolved.contextWindow).toBe(1_000_000);
    expect(rules.length).toBeGreaterThan(0);
  });

  it("tokenrhythm 站点有 1M 推荐（有依据的那条）", () => {
    expect(resolveFor(input).contextWindow).toBe(1_000_000);
  });

  it("完全没有匹配时窗口未声明（不编一个数）", () => {
    const resolved = resolveFor({ providerId: "unknown", modelId: "no-such-model", baseUrl: "https://example.invalid" });
    expect(resolved.contextWindow).toBeUndefined();
  });
});

describe("用户声明覆盖推荐", () => {
  const userRule: ModelConfigRule = {
    type: "exact",
    providerId: "tokenrhythm",
    modelId: "deepseek-v4.1-flash-1017",
    config: { properties: { contextWindow: 200_000 } },
    manual: true,
  };

  it("手动窗口赢过站点推荐", () => {
    expect(resolveFor(input, [userRule]).contextWindow).toBe(200_000);
  });

  it("手动配置标记为 manual（界面显示 override）", () => {
    expect(resolveFor(input, [userRule]).manual).toBe(true);
    expect(configSourceLabel(resolveFor(input, [userRule]))).toContain("手动");
  });

  it("只解析用户规则时看不到推荐值（界面用它算「哪些是 override」）", () => {
    const onlyUser = resolveUserOnly(input, [userRule]);
    expect(onlyUser.contextWindow).toBe(200_000);
    const nothing = resolveUserOnly(input, []);
    expect(nothing.contextWindow).toBeUndefined();
  });
});

describe("正则转义", () => {
  it("模型 id 当字面量匹配（点号不变成通配）", () => {
    const pattern = escapeRegex("deepseek-v4.1-flash-1017");
    expect(new RegExp(`^(?:${pattern})$`).test("deepseek-v4.1-flash-1017")).toBe(true);
    // 点号如果是通配，这个就会误匹配
    expect(new RegExp(`^(?:${pattern})$`).test("deepseek-v4X1-flash-1017")).toBe(false);
  });
});

describe("来源说明", () => {
  it("没有规则时说「未登记」", () => {
    expect(configSourceLabel(resolveFor({ providerId: "x", modelId: "y" }))).toContain("未登记");
  });

  it("命中推荐时说智能配置", () => {
    expect(configSourceLabel(resolveFor(input))).toContain("智能配置");
  });
});
