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
    /*
     * ⚠️ 2026-10-16（审计 G53.m）：原来只 `toContain("用")` + `toContain("React Flow")` ——
     * 输入本来就已经带空格，这两条在不加空格的实现上同样成立（关掉 spacing 也过）。
     * 现在拿**挤在一起**的输入，钉住真加了空格的结果。
     */
    const spaced = renderMarkdown("用React Flow做画布", { spacing: true, sanitize: false });
    expect(spaced, "中英之间没有自动加空格").toBe("<p>用 React Flow 做画布</p>");
    const raw = renderMarkdown("用React Flow做画布", { spacing: false, sanitize: false });
    expect(raw, "关闭 spacing 时不该动文本").toBe("<p>用React Flow做画布</p>");
  });

  it("消毒后保留允许的标签、去掉脚本", () => {
    const html = renderMarkdown("<b>x</b>", { spacing: false });
    expect(html).not.toContain("<b>");
    expect(html).toContain("x");
  });
});

describe("renderMarkdown: 不许卡死（2026-10-16，审计「四反引号预览死循环」）", () => {
  /*
   * ⚠️ 这一组的判据是"**必须自己收场**"：这些输入在修前会让 renderMarkdown 死循环
   * （段落分支的 i 不前进），窗口整个无响应。所以判据只要求"能返回且内容还在" ——
   * 一旦回归，这里不是断言失败，而是**测试进程挂住**（vitest 超时把它揪出来）。
   */
  const inputs = [
    ["四反引号围栏（演示代码块的标准写法）", "````markdown\n# 标题\n````"],
    ["带 info string 的开围栏", "```python main.py\nx = 1\n```"],
    ["带 attribute 的开围栏", '```json title="x"\n{}\n```'],
    ["objective-c 这种带短横的 info string", "``` objective-c\nint a;\n```"],
    ["单独一行四反引号", "````"],
  ];
  for (const [what, text] of inputs) {
    it("能渲染完：" + what, () => {
      const html = renderMarkdown(text, { spacing: false, sanitize: false });
      expect(typeof html, "渲染没返回字符串（死循环/崩了）").toBe("string");
      expect(html.length, "输出是空的 —— 这行文字被吞了").toBeGreaterThan(0);
    });
  }

  it("标准的 ```ts 围栏仍按代码块渲染（修段落分支没把围栏弄坏）", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```", { spacing: false, sanitize: false });
    /* 真实形态带 data-lang（`<pre data-lang="ts"><code>…`）—— 比"含 <pre"更结实一点 */
    expect(html, "标准围栏仍要是带语言标注的 pre/code").toContain('<pre data-lang="ts">');
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
