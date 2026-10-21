import { describe, expect, it } from "vitest";

import { filterProviders, groupByFamily } from "./modelLayout";

/**
 * M-01：模型页的纯布局逻辑。
 *
 * 分组顺序与搜索口径都写死在这里 —— 界面只负责画，不再各写一份。
 */
describe("按家族分组", () => {
  it("deepseek / gpt / 其它 三类各归各位", () => {
    const got = groupByFamily(["deepseek-chat", "gpt-4o-mini", "my-model", "deepseek-reasoner"]);
    expect(got.map((g) => g.family)).toEqual(["deepseek", "gpt", "其它"]);
    expect(got[0]!.models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("顺序稳定：输入顺序变化不改变分组顺序", () => {
    const a = groupByFamily(["my-model", "gpt-4o-mini", "deepseek-chat"]);
    const b = groupByFamily(["deepseek-chat", "my-model", "gpt-4o-mini"]);
    expect(a.map((g) => g.family)).toEqual(b.map((g) => g.family));
  });

  it("claude / gemini / qwen 也认得（含 vendor 前缀）", () => {
    const got = groupByFamily(["anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro", "qwen-plus"]);
    expect(got.map((g) => g.family)).toEqual(["claude", "gemini", "qwen"]);
  });

  it("空输入 → 空分组（不造一个空标题）", () => {
    expect(groupByFamily([])).toEqual([]);
  });
});

describe("左列搜索", () => {
  const list = [
    { id: "deepseek", label: "DeepSeek 官方" },
    { id: "my-relay", label: "我的中转站" },
  ];

  it("大小写不敏感，匹配 id", () => {
    expect(filterProviders(list, "DEEP").map((p) => p.id)).toEqual(["deepseek"]);
  });

  it("匹配显示名（中文也行）", () => {
    expect(filterProviders(list, "中转").map((p) => p.id)).toEqual(["my-relay"]);
  });

  it("空查询返回全部；没命中返回空数组", () => {
    expect(filterProviders(list, "   ")).toHaveLength(2);
    expect(filterProviders(list, "没有这个")).toEqual([]);
  });
});
