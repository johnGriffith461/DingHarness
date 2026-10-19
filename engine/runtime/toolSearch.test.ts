import { describe, expect, it } from "vitest";

import type { ToolEntryInput as ToolEntry } from "./registry";
import { ALWAYS_TOOLS, DEFER_THRESHOLD, rankTools, selectToolNames, tokenizeToolText } from "./toolSearch";

/**
 * 工具搜索（G03）。
 *
 * 判据：相关工具排前面、核心工具永远在、小工具集全量、没命中回退全量。
 */

const tool = (name: string, description: string): ToolEntry => ({
  name,
  source: "mcp",
  description,
  inputSchema: {} as never,
});

/** 造 60 个工具（全量 schema 太大时才会触发 deferred exposure）。 */
function catalog(): ToolEntry[] {
  const core = ALWAYS_TOOLS.map((n) => tool(n, `核心工具 ${n}`));
  const extras: ToolEntry[] = [];
  for (let i = 0; i < 60 - core.length; i += 1) {
    extras.push(tool(`connector_${i}`, `第 ${i} 个连接器工具，用于杂项操作`));
  }
  extras.push(tool("github_create_issue", "在 GitHub 仓库里创建一个 issue（问题单）"));
  extras.push(tool("slack_send_message", "往 Slack 频道发送一条消息"));
  return [...core, ...extras];
}

describe("分词", () => {
  it("英文按词、中文按双字", () => {
    expect(tokenizeToolText("create issue")).toEqual(["create", "issue"]);
    expect(tokenizeToolText("创建问题")).toEqual(["创建", "建问", "问题"]);
  });
});

describe("排序（rankTools）", () => {
  it("⭐ 查询命中的工具排在最前面", () => {
    const ranked = rankTools(catalog(), "在 GitHub 创建一个 issue");
    expect(ranked[0]?.name).toBe("github_create_issue");
  });

  it("空查询不返回任何分数（调用方据此回退全量）", () => {
    expect(rankTools(catalog(), "")).toEqual([]);
  });
});

describe("选择（selectToolNames）", () => {
  it("⭐ 工具不超过阈值 → 全量（不为了先进而改小工具集的行为）", () => {
    const small = catalog().slice(0, DEFER_THRESHOLD);
    expect(selectToolNames(small, "GitHub issue")).toEqual(small.map((t) => t.name));
  });

  it("⭐ 超过阈值：核心工具全在 + 相关工具在 + 总数显著下降", () => {
    const all = catalog();
    const got = selectToolNames(all, "往 Slack 发一条消息");
    for (const name of ALWAYS_TOOLS) expect(got, `核心工具 ${name} 被裁掉了`).toContain(name);
    expect(got).toContain("slack_send_message");
    expect(got.length, "没有下降").toBeLessThan(all.length);
    expect(got.length).toBeLessThanOrEqual(ALWAYS_TOOLS.length + 12);
  });

  it("没命中任何工具 → 回退全量（宁可多给，不能让模型找不到工具）", () => {
    const all = catalog();
    expect(selectToolNames(all, "zzzz-qqqq-xxxx")).toHaveLength(all.length);
  });

  it("不改变注入顺序（按注册表原顺序）", () => {
    const all = catalog();
    const got = selectToolNames(all, "slack");
    const expectedOrder = all.map((t) => t.name).filter((n) => got.includes(n));
    expect(got).toEqual(expectedOrder);
  });
});
