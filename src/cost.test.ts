import { describe, expect, it } from "vitest";
import { costNote, fabricatedCost } from "@shared/cost";

/**
 * C5：「消耗」这个数的唯一说法。
 *
 * ## 为什么这些断言存在
 *
 * 本体显示的是「消耗 0.48」，而实机读数写明它**按额度计量、不是 token**（`docs/HANDOFF.md:1695`）。
 * 本机版没有额度体系 —— 那个数算不出来。所以我们显示的是**按字数的估算**，
 * 而**真实用量**（provider 给的 tokens）另行如实说出。
 *
 * 这条边界很细：一旦有人把估算包装成"额度"、或者把单位偷偷换成 tokens，
 * 界面就在说一件不真的事。断言把这个边界钉住。
 */

describe("fabricatedCost（本机版那个估算数）", () => {
  it("说得越多，数越大（同一个口径下可比）", () => {
    expect(fabricatedCost("短")).toBeLessThan(fabricatedCost("长".repeat(400)));
  });

  it("有下限 0.01（空文本也不会是 0 或负数）", () => {
    expect(fabricatedCost("")).toBe(0.1);
    expect(fabricatedCost("")).toBeGreaterThanOrEqual(0.01);
  });

  it("保留两位（界面上就是「消耗 0.48」这种写法）", () => {
    expect(String(fabricatedCost("随便一段话"))).toMatch(/^\d+(\.\d{1,2})?$/);
  });

  it("喂 null/undefined 不炸（调用方在恢复路径上可能拿到空的）", () => {
    expect(fabricatedCost(null as unknown as string)).toBe(0.1);
    expect(fabricatedCost(undefined as unknown as string)).toBe(0.1);
  });
});

describe("costNote（hover 里那句如实说明）", () => {
  it("⭐ 明说这是**估算**，且明说本机没有额度体系（不许说成「额度」的真值）", () => {
    const note = costNote(0.48);
    expect(note).toContain("估算");
    expect(note).toContain("没有额度体系");
    expect(note).toContain("0.48");
  });

  it("有真实用量就一起说出来（输入/输出 tokens）", () => {
    expect(costNote(0.48, { inputTokens: 2961, outputTokens: 44 })).toContain("2961 输入 / 44 输出 tokens");
  });

  it("拿不到用量时不提那一句（**不编**）", () => {
    expect(costNote(0.48)).not.toContain("tokens");
    expect(costNote(0.48, {})).not.toContain("tokens");
  });

  it("只有一半（比如只拿到输出）也照说，缺的那半写 ?（不假装是 0）", () => {
    const note = costNote(0.48, { outputTokens: 44 });
    expect(note).toContain("? 输入 / 44 输出 tokens");
  });
});
