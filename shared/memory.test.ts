import { describe, expect, it } from "vitest";

import { memoryPromptBlock, rankMemoryEntries } from "./memory";

/** G09：按本次问题排序（记忆多了之后，"新的在前"会把相关的那条挤出上限）。 */
describe("rankMemoryEntries / 相关度注入", () => {
  const entry = (id: string, text: string) => ({
    id,
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
    source: "manual" as const,
  });

  it("空查询保持原顺序（新在前）", () => {
    const list = [entry("1", "甲"), entry("2", "乙")];
    expect(rankMemoryEntries(list, "").map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("中文两字片段命中排前面", () => {
    const list = [entry("1", "用户喜欢喝咖啡"), entry("2", "项目代号是青竹计划"), entry("3", "周五要交周报")];
    expect(rankMemoryEntries(list, "青竹计划下周要评审").map((e) => e.id)[0]).toBe("2");
  });

  it("英文按词命中（不分大小写）", () => {
    const list = [entry("1", "Deploy uses Docker"), entry("2", "the office is in Shanghai")];
    expect(rankMemoryEntries(list, "when is docker deploy").map((e) => e.id)[0]).toBe("1");
  });

  it("同分保持原顺序", () => {
    const list = [entry("1", "无关一"), entry("2", "无关二")];
    expect(rankMemoryEntries(list, "完全不同的词").map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("注入：相关的那条在字数上限内先出现（不会被挤掉）", () => {
    const lib = {
      enabled: true,
      entries: [
        { id: "new", text: "最近记的无关键", createdAt: "2026-02-01T00:00:00.000Z", source: "manual" as const },
        { id: "rel", text: "青竹计划的负责人是阿洁", createdAt: "2026-01-01T00:00:00.000Z", source: "manual" as const },
      ],
    };
    const block = memoryPromptBlock(lib, 60, "local", "青竹计划");
    expect(block.indexOf("青竹计划")).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("青竹计划")).toBeLessThan(block.indexOf("最近记的无关键"));
  });
});
