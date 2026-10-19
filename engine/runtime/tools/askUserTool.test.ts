import { describe, expect, it } from "vitest";

import { ASK_USER_MAX_OPTIONS, describeAskResult, normalizeAsk } from "./askUserTool";

/**
 * P0-07：`ask_user` 的结构校验。
 *
 * 判据：空问题拒绝、超过 5 个选项拒绝、正常输入通过；
 * 回显只说"已向用户提问"（具体的问答走问题卡，不在工具结果里演一遍）。
 */
describe("normalizeAsk", () => {
  it("空问题被拒", () => {
    expect(normalizeAsk({ question: "   " }).ok).toBe(false);
  });

  it(`超过 ${ASK_USER_MAX_OPTIONS} 个选项被拒`, () => {
    const got = normalizeAsk({
      question: "选哪个？",
      options: Array.from({ length: ASK_USER_MAX_OPTIONS + 1 }, (_, i) => ({ label: `选项 ${i}` })),
    });
    expect(got.ok).toBe(false);
  });

  it("正常输入通过（问题 + 选项 + 允许自由文本）", () => {
    const got = normalizeAsk({
      question: "用哪个包管理器？",
      options: [{ label: "pnpm", description: "快" }, { label: "npm" }],
      allow_free_text: true,
    });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.ask.question).toContain("包管理器");
      expect(got.ask.options).toHaveLength(2);
      expect(got.ask.allowFreeText).toBe(true);
    }
  });

  it("没有选项也允许（纯自由文本提问）", () => {
    const got = normalizeAsk({ question: "项目叫什么名字？" });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.ask.options).toEqual([]);
  });

  it("选项缺 label 的项被丢掉", () => {
    const got = normalizeAsk({ question: "选？", options: [{ label: "" }, { label: "A" }] });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.ask.options).toHaveLength(1);
  });
});

describe("describeAskResult", () => {
  it("回显不把问答内容再演一遍", () => {
    expect(describeAskResult()).toContain("已向用户提问");
  });
});
