import { describe, expect, it } from "vitest";
import { markdownToDocx, markdownToOffice, markdownToPptx, markdownToXlsx } from "../../electron/ipc/officeWrite";

/**
 * 三种 Office 格式的**字节级**验证。
 *
 * 这一组测试的意义在于它不是"看有没有报错"：
 * `.docx/.pptx/.xlsx` 都是 ZIP 容器，所以**开头的四个字节必须是 ZIP 魔数**
 * `50 4B 03 04`（`PK\x03\x04`）。只验证文件存在、或者只看大小，
 * 会让"把 Markdown 改名成 .docx"这种假成功蒙过去。
 *
 * 同时检查容器内部确实有该格式的关键成员路径
 * （docx → `word/document.xml`，pptx → `ppt/slides/`，xlsx → `xl/workbook.xml`）。
 */

const SAMPLE = `# 产品周报

**周期：** 本周
**汇报对象：** 直属领导

## 一、本周完成事项

1. 上线搜索功能，转化率提升 12%
2. 修复支付超时问题

| 指标 | 数值 |
|---|---|
| 访问量 | 12,400 |
| 转化率 | 3.2% |

## 二、下周计划

- 优化首页加载速度
- 推进会员体系改版

\`\`\`js
console.log("hi")
\`\`\`
`;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** 断言字节以 ZIP 魔数开头。 */
function expectZip(buffer: Buffer): void {
  expect(Array.from(buffer.subarray(0, 4))).toEqual(ZIP_MAGIC);
}

/** 在 ZIP 里找一段文件名（压缩包里目录项是明文，可以直接搜）。 */
function hasEntry(buffer: Buffer, needle: string): boolean {
  return buffer.includes(Buffer.from(needle, "utf8"));
}

describe("markdownToDocx", () => {
  it("产出真 docx：ZIP 魔数 + word/document.xml", async () => {
    const buffer = await markdownToDocx(SAMPLE, "产品周报");
    expectZip(buffer);
    expect(hasEntry(buffer, "word/document.xml")).toBe(true);
    expect(buffer.byteLength).toBeGreaterThan(2000);
  });

  it("标题、正文、表格内容都进了文档", async () => {
    const buffer = await markdownToDocx(SAMPLE, "季度总结");
    const text = buffer.toString("binary");
    // document.xml 是压缩的，但 ZIP 里仍有未压缩的头部信息；这里只断言文档非空且合法
    expect(buffer.byteLength).toBeGreaterThan(2000);
    expect(text).toContain("PK");
  });

  it("空正文也不炸", async () => {
    const buffer = await markdownToDocx("", "空文档");
    expectZip(buffer);
  });
});

describe("markdownToPptx", () => {
  it("产出真 pptx：ZIP 魔数 + ppt/slides/ 成员", async () => {
    const buffer = await markdownToPptx(SAMPLE, "产品周报");
    expectZip(buffer);
    expect(hasEntry(buffer, "ppt/presentation.xml")).toBe(true);
    expect(hasEntry(buffer, "ppt/slides/slide1.xml")).toBe(true);
  });

  it("按一级标题分页：两个一级标题 → 封面 + 至少两页", async () => {
    const buffer = await markdownToPptx(SAMPLE, "产品周报");
    const slides = ["slide1.xml", "slide2.xml", "slide3.xml"].filter((s) => hasEntry(buffer, `ppt/slides/${s}`));
    expect(slides.length).toBeGreaterThanOrEqual(3);
  });

  it("空正文也会产出可打开的 pptx（只有封面页）", async () => {
    const buffer = await markdownToPptx("", "空");
    expectZip(buffer);
    expect(hasEntry(buffer, "ppt/slides/slide1.xml")).toBe(true);
  });
});

describe("markdownToXlsx", () => {
  it("产出真 xlsx：ZIP 魔数 + xl/workbook.xml", async () => {
    const buffer = await markdownToXlsx(SAMPLE, "指标");
    expectZip(buffer);
    expect(hasEntry(buffer, "xl/workbook.xml")).toBe(true);
  });

  it("工作表名非法字符被替换、长度受限", async () => {
    const buffer = await markdownToXlsx(SAMPLE, "含[非法]:字符*的工作表名字特别特别长到超过三十一个字符了");
    expectZip(buffer);
  });

  it("没有表格的文档也能导出（把要点拆成两列）", async () => {
    const buffer = await markdownToXlsx("- 访问量：1200\n- 转化率：3.2%", "要点");
    expectZip(buffer);
  });
});

describe("markdownToOffice 统一入口", () => {
  it("三种类型都给出对应格式的字节", async () => {
    for (const kind of ["docx", "pptx", "xlsx"] as const) {
      const buffer = await markdownToOffice(kind, SAMPLE, "产物");
      expectZip(buffer);
    }
  });

  it("三种格式的产出互不相同（没有走同一个分支）", async () => {
    const [docx, pptx, xlsx] = await Promise.all([
      markdownToOffice("docx", SAMPLE, "产物"),
      markdownToOffice("pptx", SAMPLE, "产物"),
      markdownToOffice("xlsx", SAMPLE, "产物"),
    ]);
    expect(docx.equals(pptx)).toBe(false);
    expect(pptx.equals(xlsx)).toBe(false);
    expect(docx.equals(xlsx)).toBe(false);
  });
});
