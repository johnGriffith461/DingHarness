import { describe, expect, it } from "vitest";
import { bestSectionLevel, isBold, isTableDivider, parseMarkdown, splitRow, splitSections, stripInline, toTableRows } from "@shared/minimark";

describe("parseMarkdown", () => {
  it("解析标题，级别对得上", () => {
    const blocks = parseMarkdown("# 一级\n## 二级\n###### 六级");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "一级" },
      { kind: "heading", level: 2, text: "二级" },
      { kind: "heading", level: 6, text: "六级" },
    ]);
  });

  it("标题末尾的井号会被去掉", () => {
    expect(parseMarkdown("## 标题 ##")[0]).toMatchObject({ text: "标题" });
  });

  it("连续普通行并成一段", () => {
    const blocks = parseMarkdown("第一行\n第二行\n\n另起一段");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "第一行 第二行" },
      { kind: "paragraph", text: "另起一段" },
    ]);
  });

  it("无序列表：四种符号都认", () => {
    for (const mark of ["-", "*", "·", "•"]) {
      expect(parseMarkdown(`${mark} 甲\n${mark} 乙`)).toEqual([{ kind: "bullet", items: ["甲", "乙"] }]);
    }
  });

  it("有序列表：三种编号写法都认", () => {
    expect(parseMarkdown("1. 甲\n2. 乙")).toEqual([{ kind: "ordered", items: ["甲", "乙"] }]);
    expect(parseMarkdown("1) 甲\n2) 乙")[0]).toMatchObject({ kind: "ordered" });
    // 中文习惯：编号后面没有空格
    expect(parseMarkdown("1、甲\n2、乙")).toEqual([{ kind: "ordered", items: ["甲", "乙"] }]);
  });

  it("小数与年份不会被当成有序列表", () => {
    expect(parseMarkdown("1.5 倍增长")[0]).toMatchObject({ kind: "paragraph" });
    expect(parseMarkdown("2024年总结")[0]).toMatchObject({ kind: "paragraph" });
  });

  it("代码块保留原文与语言", () => {
    const blocks = parseMarkdown("```python\nprint(1)\nprint(2)\n```");
    expect(blocks).toEqual([{ kind: "code", lang: "python", lines: ["print(1)", "print(2)"] }]);
  });

  it("代码块里面的井号不当标题", () => {
    const blocks = parseMarkdown("```\n# 这是注释\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code" });
  });

  it("表格：表头 + 分隔行 + 数据行", () => {
    const blocks = parseMarkdown("| 项目 | 数值 |\n|---|---|\n| 访问量 | 1200 |\n| 转化 | 3.2% |");
    expect(blocks).toEqual([
      {
        kind: "table",
        header: ["项目", "数值"],
        rows: [
          ["访问量", "1200"],
          ["转化", "3.2%"],
        ],
      },
    ]);
  });

  it("表格支持对齐符与首尾缺竖线", () => {
    const blocks = parseMarkdown("项目 | 数值\n:--|--:\n访问量 | 1200");
    expect(blocks[0]).toMatchObject({ kind: "table", header: ["项目", "数值"] });
  });

  it("只有竖线但不是表格 → 按段落", () => {
    const blocks = parseMarkdown("a | b\nc | d");
    expect(blocks[0].kind).toBe("paragraph");
  });

  it("行内强调被去掉（样式交给各格式）", () => {
    expect(parseMarkdown("**粗体** 和 `代码` 与 [链接](http://x)")).toEqual([
      { kind: "paragraph", text: "粗体 和 代码 与 链接" },
    ]);
  });

  it("一个真实周报的混排能正确分块", () => {
    const md = `# 产品周报

**周期：** 本周
**汇报对象：** 领导

## 一、本周完成事项

1. 上线搜索功能
2. 修复支付超时

| 指标 | 数值 |
|---|---|
| 访问量 | 1200 |

## 二、下周计划

- 优化首页加载
`;
    const kinds = parseMarkdown(md).map((b) => b.kind);
    expect(kinds).toEqual(["heading", "paragraph", "heading", "ordered", "table", "heading", "bullet"]);
  });

  it("空输入返回空数组", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n  \n")).toEqual([]);
  });
});

describe("splitRow / isTableDivider", () => {
  it("拆单元格并去空白", () => {
    expect(splitRow("| a | b |")).toEqual(["a", "b"]);
    expect(splitRow("a|b")).toEqual(["a", "b"]);
  });

  it("识别分隔行", () => {
    expect(isTableDivider("|---|---|")).toBe(true);
    expect(isTableDivider("|:--|--:|")).toBe(true);
    expect(isTableDivider("| a | b |")).toBe(false);
  });
});

describe("stripInline / isBold", () => {
  it("去掉强调标记", () => {
    expect(stripInline("**a** __b__ *c* `d`")).toBe("a b c d");
  });

  it("识别整体加粗", () => {
    expect(isBold("**是**")).toBe(true);
    expect(isBold("**是**但不是整体")).toBe(false);
  });
});

describe("splitSections —— 给 PPT 一页一张", () => {
  it("按一级标题切节", () => {
    const sections = splitSections(parseMarkdown("# 甲\n内容甲\n# 乙\n内容乙"));
    expect(sections.map((s) => s.title)).toEqual(["甲", "乙"]);
    expect(sections[0].blocks).toHaveLength(1);
  });

  it("标题前的开场内容自成一节（交给兜底标题）", () => {
    const sections = splitSections(parseMarkdown("开场说明\n# 甲"));
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("开场说明");
    expect(sections[1].title).toBe("甲");
  });

  it("没有标题时用首条要点兜底当标题", () => {
    const sections = splitSections(parseMarkdown("- 第一条要点\n- 第二条"));
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("第一条要点");
  });

  it("没有一级标题时整篇算一节", () => {
    const sections = splitSections(parseMarkdown("### 三级\n段落"));
    expect(sections).toHaveLength(1);
  });

  it("空输入得到空数组", () => {
    expect(splitSections([])).toEqual([]);
  });

  it("可以按二级标题切", () => {
    const sections = splitSections(parseMarkdown("## 甲\n内容\n## 乙"), 2);
    expect(sections.map((s) => s.title)).toEqual(["甲", "乙"]);
  });
});

describe("bestSectionLevel —— 自动挑分页级别", () => {
  it("文档只有一个一级标题、正文全是二级标题时，选二级（否则只会出一页）", () => {
    const blocks = parseMarkdown("# 产品周报\n## 一、本周\n内容\n## 二、下周\n内容");
    expect(bestSectionLevel(blocks)).toBe(2);
  });

  it("有多个一级标题时选一级", () => {
    const blocks = parseMarkdown("# 甲\n内容\n# 乙\n内容");
    expect(bestSectionLevel(blocks)).toBe(1);
  });

  it("只有二级标题时直接选二级", () => {
    expect(bestSectionLevel(parseMarkdown("## 甲\n内容\n## 乙"))).toBe(2);
  });

  it("完全没有标题时退回一级（此时本来就只有一节）", () => {
    expect(bestSectionLevel(parseMarkdown("就一段话"))).toBe(1);
    expect(bestSectionLevel([])).toBe(1);
  });
});

describe("toTableRows —— 给 xlsx", () => {
  it("优先用文档里的表格块", () => {
    const blocks = parseMarkdown("| 指标 | 数值 |\n|---|---|\n| 访问 | 1200 |");
    expect(toTableRows(blocks)).toEqual({ header: ["指标", "数值"], rows: [["访问", "1200"]] });
  });

  it("多个表格合并，用第一个的表头", () => {
    const blocks = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n\n| A | B |\n|---|---|\n| 3 | 4 |");
    expect(toTableRows(blocks).rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("没有表格时把「要点：内容」拆成两列", () => {
    const blocks = parseMarkdown("- 访问量：1200\n- 转化率：3.2%");
    expect(toTableRows(blocks)).toEqual({
      header: ["项目", "内容"],
      rows: [
        ["访问量", "1200"],
        ["转化率", "3.2%"],
      ],
    });
  });

  it("没有冒号的要点只占一列", () => {
    expect(toTableRows(parseMarkdown("- 就是一句话")).rows).toEqual([["就是一句话"]]);
  });

  it("完全没内容时给空行集", () => {
    expect(toTableRows([]).rows).toEqual([]);
  });
});
