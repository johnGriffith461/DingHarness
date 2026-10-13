import { describe, expect, it } from "vitest";
import { spacing, spacingLines, __fallbackSpacing } from "./spacing";

describe("spacing（中英混排）", () => {
  it("中文与英文之间自动加空格", () => {
    const out = spacing("用React Flow做画布");
    // 具体空格形态取决于 pangu，但中英之间不能挤在一起
    expect(out).toMatch(/用\s?React/);
    expect(out).toMatch(/Flow\s?做/);
    expect(out).not.toContain("用React");
    expect(out).not.toContain("Flow做");
  });

  it("中文与数字之间自动加空格", () => {
    expect(spacing("共12个节点")).toBe("共 12 个节点");
  });

  it("空字符串安全返回", () => {
    expect(spacing("")).toBe("");
  });

  it("不破坏行内代码里的内容语义（只加空格不删字符）", () => {
    const src = "执行 `npm run build` 命令";
    const out = spacing(src);
    expect(out.replace(/\s/g, "")).toBe(src.replace(/\s/g, ""));
  });

  it("spacingLines 逐行处理并保留换行结构", () => {
    const out = spacingLines("第一行中文English\n\n第二行");
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("");
    expect(lines[0]).toMatch(/中文\s?English/);
  });
});

describe("fallbackSpacing（pangu 不可用时的兜底）", () => {
  it("中文 + 英文两侧加空格", () => {
    expect(__fallbackSpacing("中文English中文")).toBe("中文 English 中文");
  });

  it("中文 + 数字两侧加空格", () => {
    expect(__fallbackSpacing("第3章")).toBe("第 3 章");
  });

  it("中文之间的标点不加空格", () => {
    expect(__fallbackSpacing("中文，中文")).toBe("中文，中文");
  });

  it("纯英文原样返回", () => {
    expect(__fallbackSpacing("hello world")).toBe("hello world");
  });
});
