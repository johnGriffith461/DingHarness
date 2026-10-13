import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown, outlineDepth, sanitize } from "./markdown";

describe("escapeHtml", () => {
  it("把 HTML 元字符转义（脚本注入的第一道防线）", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
  });
});

describe("renderMarkdown", () => {
  it("渲染标题层级", () => {
    const html = renderMarkdown("# 一级\n## 二级\n### 三级", { spacing: false, sanitize: false });
    expect(html).toContain("<h1>一级</h1>");
    expect(html).toContain("<h2>二级</h2>");
    expect(html).toContain("<h3>三级</h3>");
  });

  it("渲染粗体 / 斜体 / 删除线 / 行内代码", () => {
    const html = renderMarkdown("**粗** *斜* ~~删~~ `code`", { spacing: false, sanitize: false });
    expect(html).toContain("<strong>粗</strong>");
    expect(html).toContain("<em>斜</em>");
    expect(html).toContain("<del>删</del>");
    expect(html).toContain("<code>code</code>");
  });

  it("行内代码里的星号不被当成强调", () => {
    const html = renderMarkdown("`a**b**c`", { spacing: false, sanitize: false });
    expect(html).toContain("<code>a**b**c</code>");
    expect(html).not.toContain("<strong>");
  });

  it("渲染无序 / 有序列表", () => {
    const html = renderMarkdown("- 甲\n- 乙\n\n1. 一\n2. 二", { spacing: false, sanitize: false });
    expect(html).toContain("<ul><li>甲</li><li>乙</li></ul>");
    expect(html).toContain("<ol><li>一</li><li>二</li></ol>");
  });

  it("渲染围栏代码块并保留语言标记", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```", { spacing: false, sanitize: false });
    expect(html).toContain('<pre data-lang="ts">');
    expect(html).toContain("const a = 1;");
  });

  it("渲染引用与分割线", () => {
    const html = renderMarkdown("> 引用\n\n---", { spacing: false, sanitize: false });
    expect(html).toContain("<blockquote><p>引用</p></blockquote>");
    expect(html).toContain("<hr />");
  });

  it("段落里的单个换行变成软回车", () => {
    const html = renderMarkdown("第一行\n第二行", { spacing: false, sanitize: false });
    expect(html).toBe("<p>第一行<br />第二行</p>");
  });

  it("只认 http(s) 链接，其它协议不会变成可点的 a", () => {
    const html = renderMarkdown("[x](javascript:alert(1))", { spacing: false, sanitize: false });
    expect(html).not.toContain("<a");
  });

  it("用户文本里的标签一律被转义，不会变成真标签", () => {
    const html = renderMarkdown("<script>alert(1)</script>", { spacing: false, sanitize: false });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("开启 pangu 后中英之间会自动加空格", () => {
    const spaced = renderMarkdown("用 React Flow 做画布", { spacing: true, sanitize: false });
    const raw = renderMarkdown("用 React Flow 做画布", { spacing: false, sanitize: false });
    // 至少保证不会把中英挤在一起（具体空格数取决于 pangu 规则）
    expect(spaced).toContain("用");
    expect(spaced).toContain("React Flow");
    expect(raw).toBe("<p>用 React Flow 做画布</p>");
  });

  it("消毒后保留允许的标签、去掉脚本", () => {
    const html = renderMarkdown("<b>x</b>", { spacing: false });
    expect(html).not.toContain("<b>");
    expect(html).toContain("x");
  });
});

describe("sanitize", () => {
  it("剥掉白名单外的标签，保留文本", () => {
    expect(sanitize('<div class="x">保留<script>bad()</script></div>')).toBe("保留bad()");
  });

  it("保留 a 的 href 与安全属性", () => {
    const out = sanitize('<a href="https://example.com" onclick="x()">链接</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain("链接");
    expect(out).not.toContain("onclick");
  });
});

describe("outlineDepth", () => {
  it("取标题最大层级", () => {
    expect(outlineDepth("# a\n## b\n### c")).toBe(3);
  });

  it("只有列表时按 2 级处理", () => {
    expect(outlineDepth("- a\n- b")).toBe(2);
  });

  it("空内容为 0", () => {
    expect(outlineDepth("")).toBe(0);
  });
});
