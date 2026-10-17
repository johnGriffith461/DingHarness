import { describe, expect, it } from "vitest";

import {
  PLUGIN_INDEX_FORMAT,
  engineIncompatibility,
  parsePluginIndex,
  satisfiesEngines,
  searchPluginIndex,
} from "./pluginIndex";

/**
 * 插件市场索引（V6-3d）。
 *
 * 三件事必须钉住：
 *   ① `engines.ding` **真的比较**（这是原来"声明了却从不生效"的那一格）；
 *   ② 看不懂的范围**当不兼容**（保守，不能放一个没验证过的插件进宿主）；
 *   ③ 搜索把不兼容的条目也列出来（用户有权知道它存在），但沉下去。
 */

describe("engines.ding 范围判断", () => {
  it("精确 / 比较 / caret / tilde / 通配", () => {
    expect(satisfiesEngines("0.5.0", "0.5.0")).toBe(true);
    expect(satisfiesEngines("0.5.0", "0.5.1")).toBe(false);
    expect(satisfiesEngines(">=0.5.0", "0.6.0")).toBe(true);
    expect(satisfiesEngines(">0.5.0", "0.5.0")).toBe(false);
    expect(satisfiesEngines("<=0.5.0", "0.5.0")).toBe(true);
    expect(satisfiesEngines("<0.5.0", "0.4.9")).toBe(true);
    expect(satisfiesEngines("*", "0.5.0")).toBe(true);
  });

  it("caret 的 0.x 语义：0.2 的下一位是破坏位", () => {
    expect(satisfiesEngines("^0.2.0", "0.2.9")).toBe(true);
    expect(satisfiesEngines("^0.2.0", "0.3.0")).toBe(false);
    expect(satisfiesEngines("^1.2.0", "1.9.9")).toBe(true);
    expect(satisfiesEngines("^1.2.0", "2.0.0")).toBe(false);
  });

  it("tilde：只允许补丁位变", () => {
    expect(satisfiesEngines("~1.2.3", "1.2.9")).toBe(true);
    expect(satisfiesEngines("~1.2.3", "1.3.0")).toBe(false);
    expect(satisfiesEngines("~1", "1.9.0")).toBe(true);
    expect(satisfiesEngines("~1", "2.0.0")).toBe(false);
  });

  it("空格 AND / || OR；看不懂的范围当不兼容", () => {
    expect(satisfiesEngines(">=0.4.0 <0.6.0", "0.5.0")).toBe(true);
    expect(satisfiesEngines(">=0.4.0 <0.6.0", "0.6.0")).toBe(false);
    expect(satisfiesEngines("<0.4.0 || >=0.5.0", "0.5.0")).toBe(true);
    expect(satisfiesEngines("banana", "0.5.0")).toBe(false);
    expect(satisfiesEngines("", "0.5.0")).toBe(false);
  });

  it("安装门给一句能直接展示的话", () => {
    expect(engineIncompatibility(">=0.5.0", "0.5.0")).toBeNull();
    const why = engineIncompatibility(">=9.0.0", "0.5.0");
    expect(why).toContain("要求 ding >=9.0.0");
    expect(why).toContain("0.5.0");
  });
});

describe("索引解析", () => {
  const good = {
    id: "word-count",
    name: "字数统计",
    version: "1.0.0",
    enginesDing: ">=0.5.0",
    npm: "ding-plugin-word-count",
    tags: ["统计", "sample"],
  };

  it("format 不对 → 直接拒（不猜旧格式）", () => {
    const parsed = parsePluginIndex({ format: 2, plugins: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain("format 1");
    expect(PLUGIN_INDEX_FORMAT).toBe(1);
  });

  it("坏条目跳过并报出原因；重复 id 只留第一条", () => {
    const parsed = parsePluginIndex({
      format: 1,
      plugins: [good, { ...good, id: "no-version", version: "x" }, { id: "" }, { ...good, npm: undefined }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.index.plugins).toHaveLength(1);
    expect(parsed.problems.length).toBe(3);
    expect(parsed.problems.join("\n")).toMatch(/version|id|安装来源/);
  });

  it("local 条目（离线示例）能读进来", () => {
    const parsed = parsePluginIndex({ format: 1, plugins: [{ ...good, npm: undefined, local: "../plugin-samples/word-count" }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.index.plugins[0]?.local).toBe("../plugin-samples/word-count");
  });
});

describe("搜索", () => {
  const index = {
    format: 1,
    plugins: [
      { id: "word-count", name: "字数统计", version: "1.0.0", enginesDing: ">=0.5.0", npm: "a", tags: ["统计", "sample"] },
      { id: "future", name: "未来插件", version: "2.0.0", enginesDing: ">=9.0.0", npm: "b", tags: ["sample"] },
      { id: "pdf-export", name: "PDF 导出", version: "1.0.0", enginesDing: "*", npm: "c", description: "把文档导出成 pdf" },
    ],
  };

  it("中文按子串、英文按词；命中 tags/description", () => {
    expect(searchPluginIndex(index, "字数", "0.5.0").map((h) => h.id)).toEqual(["word-count"]);
    expect(searchPluginIndex(index, "pdf", "0.5.0").map((h) => h.id)).toEqual(["pdf-export"]);
    expect(searchPluginIndex(index, "sample", "0.5.0").map((h) => h.id)).toEqual(["word-count", "future"]);
    expect(searchPluginIndex(index, "没有这个", "0.5.0")).toEqual([]);
  });

  it("不兼容的条目仍然列出（⚠️），但排在兼容的后面，并说明原因", () => {
    const hits = searchPluginIndex(index, "sample", "0.5.0");
    expect(hits.map((h) => h.id)).toEqual(["word-count", "future"]);
    expect(hits[0]?.compatible).toBe(true);
    expect(hits[1]?.compatible).toBe(false);
    expect(hits[1]?.incompatibility).toContain("ding >=9.0.0");
  });

  it("空查询 = 全部（按兼容与名字排序），不是空结果", () => {
    const hits = searchPluginIndex(index, "", "0.5.0");
    expect(hits).toHaveLength(3);
    expect(hits[0]?.compatible).toBe(true);
    expect(hits.at(-1)?.id).toBe("future");
  });
});
