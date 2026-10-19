import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";

/**
 * T-03：助手回答的 Markdown 渲染。
 *
 * 判据（全部可观察）：
 * - `**加粗**` → `<strong>`，`` `code` `` → `<code>`，`- a` → `<ul>`，围栏 → `<pre><code>`；
 * - **原始 HTML 不渲染**（`<img onerror>` 必须作为文本出现，不产生 `<img>` 标签）——
 *   这是 XSS 的底线：我们只开 GFM，不开 `rehype-raw`；
 * - 外链带 `rel="noreferrer noopener"` 与 `target="_blank"`。
 */
function html(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text }));
}

describe("Markdown", () => {
  it("加粗 / 行内代码 / 无序列表", () => {
    const out = html("**重点** 和 `code`\n\n- a\n- b");
    expect(out).toContain("<strong>重点</strong>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>a</li>");
  });

  it("代码围栏 → pre/code，且保留等宽块结构", () => {
    const out = html("```ts\nconst a = 1;\n```");
    expect(out).toContain("<pre>");
    expect(out).toContain("<code");
    expect(out).toContain("const a = 1;");
  });

  it("⭐ 原始 HTML 不执行：<img onerror> 只能作为文本出现", () => {
    const out = html('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
    expect(out).toContain("onerror");
  });

  it("GFM 表格可用", () => {
    const out = html("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>a</th>");
  });

  it("外链带安全属性", () => {
    const out = html("[文档](https://example.com/x)");
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('rel="noreferrer noopener"');
    expect(out).toContain('target="_blank"');
  });

  it("标题渲染成 heading", () => {
    expect(html("## 小节")).toContain("<h2>小节</h2>");
  });
});
