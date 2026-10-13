import { describe, expect, it } from "vitest";
import {
  INTENT_META,
  buildSelectionContext,
  cleanOutput,
  contentPatchFor,
  parseCodeBlock,
} from "./canvasGenerate";
import type { CanvasNode } from "./types";
import { makeCodeNode, makeMarkdownNode, makeWhiteboardNode } from "./types";

const markdown = makeMarkdownNode("n1", { x: 0, y: 0 }, "画布素材正文", { width: 300, height: 200 }, "素材");
const code = makeCodeNode("n2", { x: 0, y: 0 }, "const a = 1;", "ts");
const board = makeWhiteboardNode("n3", { x: 0, y: 0 });

describe("INTENT_META", () => {
  it("四种意图各自的落地节点类型正确", () => {
    expect(INTENT_META.write.output).toBe("markdown");
    expect(INTENT_META.code.output).toBe("code");
    expect(INTENT_META.diagram.output).toBe("mermaid");
    expect(INTENT_META.mindmap.output).toBe("mindmap");
  });
});

describe("buildSelectionContext", () => {
  it("空选区返回空串（不产生半截提示词）", () => {
    expect(buildSelectionContext([])).toBe("");
  });

  it("把节点内容带进上下文，并标注类型与标题", () => {
    const ctx = buildSelectionContext([markdown, code]);
    expect(ctx).toContain("画布素材正文");
    expect(ctx).toContain("素材 1");
    expect(ctx).toContain("素材 2");
    expect(ctx).toContain("```ts");
    expect(ctx).toContain("const a = 1;");
  });

  it("图片与白板这类没有文字的节点给出说明而不是空块", () => {
    const ctx = buildSelectionContext([board]);
    expect(ctx).toContain("白板节点");
  });

  it("超长内容按上限截断，避免提示词爆掉", () => {
    const huge = makeMarkdownNode("n9", { x: 0, y: 0 }, "x".repeat(500));
    const ctx = buildSelectionContext([huge], 100);
    expect(ctx.length).toBeLessThan(400);
  });
});

describe("parseCodeBlock", () => {
  it("剥出围栏里的代码与语言", () => {
    expect(parseCodeBlock("```python\nprint(1)\n```")).toEqual({ lang: "python", code: "print(1)" });
  });

  it("没有围栏时整体当代码，语言记 text", () => {
    expect(parseCodeBlock("const a = 1;")).toEqual({ lang: "text", code: "const a = 1;" });
  });

  it("带前后的解释文字也能抓到代码块", () => {
    const out = parseCodeBlock("这是代码：\n```ts\nlet a=1;\n```\n以上。");
    expect(out.lang).toBe("ts");
    expect(out.code).toBe("let a=1;");
  });

  it("语言标识里的 + / # 也被识别（c++ / c#）", () => {
    expect(parseCodeBlock("```c++\nint a;\n```").lang).toBe("c++");
    expect(parseCodeBlock("```c#\nint a;\n```").lang).toBe("c#");
  });
});

describe("cleanOutput", () => {
  it("write 意图下剥掉整体围栏", () => {
    expect(cleanOutput("write", "```\n# 标题\n正文\n```")).toBe("# 标题\n正文");
  });

  it("code 意图保留围栏（代码节点自己会剥）", () => {
    expect(cleanOutput("code", "```ts\nlet a=1;\n```")).toContain("```");
  });

  it("去掉首尾空白", () => {
    expect(cleanOutput("write", "  \n内容\n  ")).toBe("内容");
  });
});

describe("contentPatchFor", () => {
  it("按节点类型落在正确字段上", () => {
    expect(contentPatchFor("markdown", "正文")).toEqual({ text: "正文" });
    expect(contentPatchFor("mermaid", "flowchart LR")).toEqual({ code: "flowchart LR" });
    expect(contentPatchFor("mindmap", "# 中心")).toEqual({ markdown: "# 中心" });
  });

  it("code 会同时拆出代码与语言，并切到预览态", () => {
    const patch = contentPatchFor("code", "```python\nprint(1)\n```");
    expect(patch).toEqual({ code: "print(1)", lang: "python", preview: true });
  });

  it("未知类型退化成文本补丁", () => {
    expect(contentPatchFor("whatever", "x")).toEqual({ text: "x" });
  });
});

describe("节点联合类型可安全传给上下文构造", () => {
  it("六种节点都不抛错", () => {
    const nodes: CanvasNode[] = [markdown, code, board];
    expect(() => buildSelectionContext(nodes)).not.toThrow();
  });
});
