import { describe, expect, it } from "vitest";
import { buildSelectionContext, truncateByCodePoint } from "./canvasGenerate";
import { makeMarkdownNode } from "./types";

/**
 * 按**码点**截断（2026-10-16，审计 P255）。
 *
 * ## 为什么单开一个文件写这条
 *
 * P255 报的活口原来记在 `src/canvas/references.ts:192`，而那个文件已经不在了 ——
 * 同一句 `slice(0, maxChars)` 现在的家是 `canvasGenerate.ts` 的 `buildSelectionContext`。
 * 这正是"总账行号是旧锚点"的那一类：**先核对现状，再决定改哪里**。
 *
 * ## 判据为什么是"完整串"而不是字数
 *
 * `String.prototype.slice` 数的是 **UTF-16 码元**。截点落在代理对内部时（emoji、
 * CJK 扩展 B 的 `𠮷`、数学粗体字母 —— 中英混排的 AI 正文里很常见），结果串以**孤立高位代理**结尾：
 *   · `JSON.stringify` 写成 `\uD8xx` 这样的转义（多数上游直接报 malformed）；
 *   · fetch 编码请求体时替换成 U+FFFD；
 * 于是**正文最后一个字与提示词形态都变了**，而没有任何东西会报错。
 * 所以判据是"结果串仍然 well-formed" + "码点数对得上"。
 *
 * ## 变异实证
 *
 * 把 `truncateByCodePoint` 的实现换回 `text.slice(0, maxChars)` → 前两条用例红。
 */

describe("truncateByCodePoint（P255）", () => {
  it("⭐ 截点落在代理对中间时，不许切出半个字符", () => {
    // 𠮷（CJK 扩展 B）是 1 个码点 / 2 个码元，后面跟普通字
    const text = "a\u{20BB7}\u0062";
    expect(Array.from(text).length, "先确认这条样本真是 3 个码点").toBe(3);
    const cut = truncateByCodePoint(text, 2);
    expect(Array.from(cut).join("")).toBe("a\u{20BB7}");
    expect(cut.isWellFormed(), "结果串必须完整 —— 不许以孤立代理结尾").toBe(true);
  });

  it("⭐ 截出来的串喂给 JSON 也不许出现半个代理对的转义", () => {
    const one = "\u{1F600}"; // 1 个码点 / 2 个码元
    const cut = truncateByCodePoint(one.repeat(5), 3);
    expect(Array.from(cut).length).toBe(3);
    expect(cut).toBe(one.repeat(3));
    // 半个代理对会被 JSON 写成 \uD83D 这种（大写 D8/D9 开头的高位代理）
    expect(JSON.stringify(cut)).not.toMatch(/\\u[dD][89abAB][0-9a-fA-F]{2}/);
  });

  it("没超上限时原样返回（快路径不许改动内容）", () => {
    expect(truncateByCodePoint("abc", 10)).toBe("abc");
    expect(truncateByCodePoint("", 3)).toBe("");
    expect(truncateByCodePoint("\u{1F600}", 1), "一个码点也算没超").toBe("\u{1F600}");
  });

  it("上下文块走的就是它：巨型 emoji 正文截出来仍是合法串", () => {
    const node = makeMarkdownNode("n1", { x: 0, y: 0 }, "\u{1F600}".repeat(50));
    const ctx = buildSelectionContext([node], 3);
    expect(ctx.isWellFormed()).toBe(true);
    expect(ctx).toContain("\u{1F600}".repeat(3));
  });
});
