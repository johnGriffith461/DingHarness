import { describe, expect, it } from "vitest";
import { extractArtifacts, extractFencedArtifact } from "./artifact";

/**
 * 兜底提取（模型没用 `<artifact>` 标签时）。
 *
 * 门槛是这套逻辑里最要紧的部分：**宁可漏掉，也不要把解释里的片段变成文件**。
 * 用户看到正文里一句话被拆成一个 .md 文件，比"没有产物"更让人困惑。
 */

const big = (lang: string) => "```" + lang + "\n" + "<div>x</div>\n".repeat(60) + "```";

describe("extractFencedArtifact —— 什么该当产物", () => {
  it("恰好一段、够长、语言认得出 → 提出来", () => {
    const source = `已经生成好了：\n\n${big("html")}\n\n需要我调整配色吗？`;
    const { text, artifact } = extractFencedArtifact(source);
    expect(artifact?.kind).toBe("html");
    expect(artifact?.content).toContain("<div>x</div>");
    expect(text).toContain("已经生成好了");
    expect(text).toContain("需要我调整配色吗");
    expect(text).not.toContain("```");
  });

  it("**两段代码块 → 不动**（解释里夹片段很常见，只认「恰好一段」）", () => {
    const source = `${big("html")}\n\n还有另一种写法：\n\n${big("html")}`;
    expect(extractFencedArtifact(source).artifact).toBeNull();
  });

  it("**太短 → 不动**（400 字符以下当片段）", () => {
    const source = "```html\n<div>短</div>\n```";
    expect(extractFencedArtifact(source).artifact).toBeNull();
  });

  it("**语言不在白名单 → 不动**（bash/json 更常是解释的一部分）", () => {
    const source = "```bash\n" + "echo hello\n".repeat(60) + "```";
    expect(extractFencedArtifact(source).artifact).toBeNull();
  });

  it("没有代码块 → 不动", () => {
    const { text, artifact } = extractFencedArtifact("就是一段普通回答。");
    expect(artifact).toBeNull();
    expect(text).toBe("就是一段普通回答。");
  });

  it("markdown / svg 也认", () => {
    // 夹具要**明显超过门槛**：正好卡在边界上的用例会把"边界行为"和"类型支持"混在一起测
    expect(extractFencedArtifact("```markdown\n" + "# 标题\n".repeat(100) + "```").artifact?.kind).toBe("markdown");
    expect(extractFencedArtifact("```svg\n" + "<circle r='1'/>\n".repeat(40) + "```").artifact?.kind).toBe("html");
  });

  it("刚好卡在门槛上（trim 之后 399 字符）→ 不动 —— 边界行为写死在这里", () => {
    const justUnder = "```markdown\n" + "# 标题\n".repeat(80) + "```";
    expect(extractFencedArtifact(justUnder).artifact).toBeNull();
  });

  it("语言标记大小写不敏感", () => {
    expect(extractFencedArtifact("```HTML\n" + "<p>x</p>\n".repeat(60) + "```").artifact?.kind).toBe("html");
  });
});

describe("extractArtifacts 里接上兜底", () => {
  const mk = (i: number) => `a${i}`;

  it("**有明显标签时用标签，不走兜底**（否则同一段会出两个产物）", () => {
    const source = '前言\n<artifact type="html" title="页面">\n<div>标签里的</div>\n</artifact>\n' + big("html");
    const out = extractArtifacts(source, "t1", 1, mk, "s1");
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0].title).toBe("页面");
    expect(out.artifacts[0].content).toContain("标签里的");
  });

  it("模型没吐标签时，兜底把大代码块当产物", () => {
    const source = `这是为你生成的页面：\n\n${big("html")}\n\n需要调整吗？`;
    const out = extractArtifacts(source, "t1", 1, mk, "s1");
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0].kind).toBe("html");
    expect(out.artifacts[0].stepId).toBe("s1");
    expect(out.text).toContain("这是为你生成的页面");
    expect(out.text).not.toContain("```");
  });

  it("**标题从内容里取**（HTML 的 <title>），取不到才退到泛化名字", () => {
    const source =
      "```html\n" + '<html><head><title>今日待办</title></head><body>' + "<div>x</div>".repeat(50) + "</body></html>\n```";
    const out = extractArtifacts(source, "t1", 1, mk, "s1");
    expect(out.artifacts[0].title).toBe("今日待办");
  });

  it("没有 <title> 的 HTML 退到首行", () => {
    const source = "```html\n<!-- 我的页面 -->\n" + "<div>x</div>".repeat(60) + "\n```";
    const out = extractArtifacts(source, "t1", 1, mk, "s1");
    expect(out.artifacts[0].title).toContain("我的页面");
  });

  it("普通问答（没有大代码块）仍然没有产物", () => {
    const out = extractArtifacts("复利就是利滚利。", "t1", 1, mk, "s1");
    expect(out.artifacts).toHaveLength(0);
    expect(out.text).toBe("复利就是利滚利。");
  });
});
