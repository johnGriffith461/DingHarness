import { describe, expect, it } from "vitest";
import {
  ARTIFACT_FORMATS,
  artifactFileName,
  extractArtifacts,
  normalizeKind,
  titleFromContent,
} from "./artifact";

const id = (i: number) => `a${i + 1}`;

describe("normalizeKind", () => {
  it("认标准名", () => {
    expect(normalizeKind("markdown")).toBe("markdown");
    expect(normalizeKind("docx")).toBe("docx");
    expect(normalizeKind("pptx")).toBe("pptx");
    expect(normalizeKind("xlsx")).toBe("xlsx");
    expect(normalizeKind("html")).toBe("html");
    expect(normalizeKind("canvas")).toBe("canvas");
  });

  it("认常见别名（模型不一定听话）", () => {
    expect(normalizeKind("Word")).toBe("docx");
    expect(normalizeKind("doc")).toBe("docx");
    expect(normalizeKind("PPT")).toBe("pptx");
    expect(normalizeKind("slides")).toBe("pptx");
    expect(normalizeKind("Excel")).toBe("xlsx");
    expect(normalizeKind("sheet")).toBe("xlsx");
    expect(normalizeKind("md")).toBe("markdown");
    expect(normalizeKind("py")).toBe("code");
  });

  it("认不出来按 markdown（最通用）", () => {
    expect(normalizeKind("???" )).toBe("markdown");
    expect(normalizeKind(undefined)).toBe("markdown");
    expect(normalizeKind("")).toBe("markdown");
  });

  it("大小写与空白不影响", () => {
    expect(normalizeKind("  DOCX  ")).toBe("docx");
  });
});

describe("ARTIFACT_FORMATS", () => {
  it("每种类型都有扩展名与 mime", () => {
    for (const [kind, format] of Object.entries(ARTIFACT_FORMATS)) {
      expect(format.ext, kind).toBeTruthy();
      expect(format.mime, kind).toContain("/");
      expect(format.label, kind).toBeTruthy();
    }
  });

  it("扩展名不重复", () => {
    const exts = Object.values(ARTIFACT_FORMATS).map((f) => f.ext);
    expect(new Set(exts).size).toBe(exts.length);
  });

  it("Office 三类的扩展名必须是它们真正的格式（主进程会据此构造 ZIP）", () => {
    expect(ARTIFACT_FORMATS.docx.ext).toBe("docx");
    expect(ARTIFACT_FORMATS.pptx.ext).toBe("pptx");
    expect(ARTIFACT_FORMATS.xlsx.ext).toBe("xlsx");
    // 不能把 Office 类型写成 md —— 那样主进程就不会走生成器了
    expect(ARTIFACT_FORMATS.docx.mime).toContain("wordprocessingml");
    expect(ARTIFACT_FORMATS.pptx.mime).toContain("presentationml");
    expect(ARTIFACT_FORMATS.xlsx.mime).toContain("spreadsheetml");
  });
});

describe("extractArtifacts", () => {
  it("提取一个产物，正文里只剩给人看的话", () => {
    const raw = `周报写好了，见下方产物。

<artifact type="docx" title="产品周报">
# 产品周报
- 本周进展：上线了三个功能
</artifact>`;
    const out = extractArtifacts(raw, "t1", 1000, id);
    expect(out.text).toBe("周报写好了，见下方产物。");
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0]).toMatchObject({
      id: "a1",
      taskId: "t1",
      title: "产品周报",
      kind: "docx",
      createdAt: 1000,
    });
    expect(out.artifacts[0].content).toContain("本周进展：上线了三个功能");
  });

  it("没有产物块 → 原样正文、零产物", () => {
    const out = extractArtifacts("就是一段普通回复", "t1", 1, id);
    expect(out.text).toBe("就是一段普通回复");
    expect(out.artifacts).toEqual([]);
  });

  it("一条回复里多个产物都收（实测原版常一次给多份）", () => {
    const raw = `两样都给你：
<artifact type="md" title="说明">说明正文</artifact>
中间的话
<artifact type="html" title="展示页"><h1>hi</h1></artifact>`;
    const out = extractArtifacts(raw, "t1", 1, id);
    expect(out.artifacts.map((a) => a.kind)).toEqual(["markdown", "html"]);
    expect(out.artifacts.map((a) => a.title)).toEqual(["说明", "展示页"]);
    expect(out.text).toContain("两样都给你");
    expect(out.text).toContain("中间的话");
    expect(out.text).not.toContain("artifact");
  });

  it("单引号属性、无引号属性都能读", () => {
    const out = extractArtifacts("<artifact type='pptx' title='路演稿'>x</artifact>", "t", 1, id);
    expect(out.artifacts[0]).toMatchObject({ kind: "pptx", title: "路演稿" });
  });

  it("包在围栏里的正文会脱掉围栏", () => {
    const out = extractArtifacts('<artifact type="py" title="脚本">\n```python\nprint(1)\n```\n</artifact>', "t", 1, id);
    expect(out.artifacts[0].content).toBe("print(1)");
  });

  it("没给 title 就按类型兜底起名", () => {
    const out = extractArtifacts('<artifact type="md">正文</artifact>', "t", 1, id);
    expect(out.artifacts[0].title).toBe("文档1");
  });

  it("空产物不记（模型偶尔先写个空壳）", () => {
    const out = extractArtifacts('<artifact type="md" title="空"></artifact>实际内容', "t", 1, id);
    expect(out.artifacts).toEqual([]);
    expect(out.text).toContain("实际内容");
  });

  it("标记不完整时不当产物，也不把内容吃掉", () => {
    const out = extractArtifacts('<artifact type="md" title="x">没有收尾', "t", 1, id);
    expect(out.artifacts).toEqual([]);
    expect(out.text).toContain("没有收尾");
  });

  it("正文里的尖括号不会被误判成产物", () => {
    const out = extractArtifacts("用 <div> 和 <span> 排版", "t", 1, id);
    expect(out.artifacts).toEqual([]);
    expect(out.text).toContain("<div>");
  });

  it("空输入不炸", () => {
    expect(extractArtifacts("", "t", 1, id)).toEqual({ text: "", artifacts: [] });
    expect(extractArtifacts(undefined as unknown as string, "t", 1, id)).toEqual({ text: "", artifacts: [] });
  });

  it("产物 id 递增（界面 key 要用）", () => {
    const raw = '<artifact type="md">a</artifact><artifact type="md">b</artifact>';
    expect(extractArtifacts(raw, "t", 1, id).artifacts.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});

describe("artifactFileName", () => {
  it("按类型给扩展名", () => {
    expect(artifactFileName({ title: "产品周报", kind: "docx" })).toBe("产品周报.docx");
    expect(artifactFileName({ title: "路演", kind: "pptx" })).toBe("路演.pptx");
    expect(artifactFileName({ title: "数据", kind: "xlsx" })).toBe("数据.xlsx");
  });

  it("路径分隔符与非法字符被替换（不能让标题跑出目录）", () => {
    expect(artifactFileName({ title: "a/b\\c:d*e?f", kind: "markdown" })).toBe("a-b-c-d-e-f.md");
    expect(artifactFileName({ title: "../../etc/passwd", kind: "markdown" })).not.toContain("/");
  });

  it("只有点的标题不会变成 .. 之类", () => {
    expect(artifactFileName({ title: "..", kind: "markdown" })).toBe("产物.md");
    expect(artifactFileName({ title: ".", kind: "markdown" })).toBe("产物.md");
  });

  it("超长标题被截断", () => {
    const name = artifactFileName({ title: "长".repeat(200), kind: "markdown" });
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it("空标题有兜底", () => {
    expect(artifactFileName({ title: "   ", kind: "markdown" })).toBe("产物.md");
  });
});

describe("titleFromContent", () => {
  it("优先取第一个标题行", () => {
    expect(titleFromContent("开场白\n# 产品周报\n正文")).toBe("产品周报");
    expect(titleFromContent("### 三级标题")).toBe("三级标题");
  });

  it("没有标题行就取第一行非空", () => {
    expect(titleFromContent("\n\n直接就是正文\n后面")).toBe("直接就是正文");
  });

  it("去掉列表符号", () => {
    expect(titleFromContent("- 一条要点")).toBe("一条要点");
  });

  it("空内容返回空串", () => {
    expect(titleFromContent("")).toBe("");
    expect(titleFromContent("   \n  ")).toBe("");
  });
});
