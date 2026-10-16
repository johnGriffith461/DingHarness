import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
// 主进程侧一律用**相对路径**引 shared：tsconfig.electron.json 没有配 paths 别名，
// 而 shared 会被一起编到 dist-electron/shared（见 imageGen.ts 的同一做法）。
import { bestSectionLevel, parseMarkdown, splitSections, toTableRows, type MdBlock } from "../../shared/minimark";

/**
 * 把产物的 Markdown 正文转成**真格式**（阶段 11.2）。
 *
 * 为什么不能直接写文本：`.docx/.pptx/.xlsx` 都是 ZIP 包（内部的 XML 才有意义）。
 * 往这些扩展名里写 Markdown 会得到一个**打不开的坏文件** —— 比不产出还糟，
 * 因为它看起来像成功了。
 *
 * 三种格式吃同一份 `shared/minimark` 解析出来的块序列，各自映射：
 *   docx → 标题级别 / 列表 / 表格 / 代码块（等宽字体）
 *   pptx → 按一级标题分页，每页标题 + 要点
 *   xlsx → 优先用文档里的表格；没有就把「要点：内容」拆成两列
 */

/** 支持的三种 Office 格式。 */
export type OfficeKind = "docx" | "pptx" | "xlsx";

/** 标题级别 → docx 的 HeadingLevel。 */
const HEADING_MAP = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

/**
 * Markdown → Word 文档 Buffer。
 *
 * @param markdown 正文
 * @param title 文档标题（会作为首行大标题）
 * @returns .docx 的字节
 */
export async function markdownToDocx(markdown: string, title: string): Promise<Buffer> {
  const blocks = parseMarkdown(markdown);
  const children: Array<Paragraph | Table> = [];

  if (title.trim()) {
    children.push(new Paragraph({ text: title.trim(), heading: HeadingLevel.TITLE }));
  }

  for (const block of blocks) {
    children.push(...blockToDocx(block));
  }

  const doc = new Document({
    creator: "工作台",
    title: title || "产物",
    sections: [{ children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** 单块 → docx 段落/表格。 */
function blockToDocx(block: MdBlock): Array<Paragraph | Table> {
  switch (block.kind) {
    case "heading":
      return [
        new Paragraph({
          text: block.text,
          heading: HEADING_MAP[Math.min(block.level, 6) - 1],
          spacing: { before: 240, after: 120 },
        }),
      ];

    case "paragraph":
      return [new Paragraph({ text: block.text, spacing: { after: 120 } })];

    case "bullet":
      return block.items.map(
        (item: string) => new Paragraph({ text: item, bullet: { level: 0 }, spacing: { after: 60 } }),
      );

    case "ordered":
      return block.items.map(
        (item: string, index: number) => new Paragraph({ text: `${index + 1}. ${item}`, spacing: { after: 60 } }),
      );

    case "code":
      return block.lines.length
        ? block.lines.map(
            (line: string) =>
              new Paragraph({
                children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })],
                spacing: { after: 0 },
              }),
          )
        : [new Paragraph({ text: "" })];

    case "table": {
      const headerRow = new TableRow({
        tableHeader: true,
        children: block.header.map(
          (cell: string) =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: cell, bold: true })] })],
            }),
        ),
      });
      const bodyRows = block.rows.map(
        (row: string[]) =>
          new TableRow({
            children: row.map(
              (cell: string) => new TableCell({ children: [new Paragraph({ text: cell })] }),
            ),
          }),
      );
      return [new Table({ rows: [headerRow, ...bodyRows], width: { size: 100, type: "pct" } })];
    }

    default:
      return [];
  }
}

/**
 * 一页最多放几条要点（超出的**另起一页**，不再默默扔掉）。
 *
 * 2026-10-16（审计 P226）：这里原来是 `bullets.slice(0, 12)` ——
 * 第 13 条往后的正文**直接消失**，而函数照样返回 Buffer、上层照样报"已生成"。
 * 长文最容易命中：`bestSectionLevel`（`shared/minimark.ts`）在没有标题时返回 1，
 * 整篇变成一节一页，于是"一页 12 条"就吃掉了整篇文档的大部分。
 *
 * 12 这个数是**排版**决定的（16pt × 1.3 行距在 16:9 上放得下 12 行），
 * 所以分页而不是放大字体 —— 排版口径不变，内容一条不丢。
 */
const PPTX_BULLETS_PER_SLIDE = 12;

/**
 * Markdown → PowerPoint Buffer。
 *
 * 分页规则：按一级标题一页；没有一级标题时整篇一页。每页标题 + 该页的要点。
 * 一节里的要点超过一页能放的条数 → **续页**（标题带「（续）」），一条都不丢。
 *
 * @param markdown 正文
 * @param title 演示文稿标题（第一页封面）
 * @returns .pptx 的字节
 */
export async function markdownToPptx(markdown: string, title: string): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.title = title || "产物";

  // 封面
  const cover = pptx.addSlide();
  cover.addText(title || "产物", {
    x: 0.6,
    y: 2.2,
    w: 8.8,
    h: 1.4,
    fontSize: 36,
    bold: true,
    align: "center",
    color: "1B1D21",
  });

  const blocks = parseMarkdown(markdown);
  const sections = splitSections(blocks, bestSectionLevel(blocks));
  for (const section of sections) {
    const bullets = bulletsOf(section.blocks);
    /*
     * ⚠️ 要点一条都不许丢（P226）：按每页容量切段，第一段放本节，后面的走续页。
     * 空要点也要出一页（保持"一节至少一页"的原有形状，不要变成空文档）。
     */
    const pages: string[][] = [];
    for (let i = 0; i < bullets.length; i += PPTX_BULLETS_PER_SLIDE) {
      pages.push(bullets.slice(i, i + PPTX_BULLETS_PER_SLIDE));
    }
    if (!pages.length) pages.push([]);

    pages.forEach((pageBullets, pageIndex) => {
      const slide = pptx.addSlide();
      const heading = section.title
        ? pageIndex === 0
          ? section.title
          : `${section.title}（续 ${pageIndex}）`
        : pageIndex === 0
          ? ""
          : `（续 ${pageIndex}）`;
      if (heading) {
        slide.addText(heading, {
          x: 0.5,
          y: 0.35,
          w: 9,
          h: 0.9,
          fontSize: 26,
          bold: true,
          color: "1B1D21",
        });
      }
      if (pageBullets.length > 0) {
        slide.addText(
          pageBullets.map((text: string) => ({ text, options: { bullet: true, breakLine: true } })),
          { x: 0.6, y: 1.5, w: 8.8, h: 3.6, fontSize: 16, color: "33383F", lineSpacingMultiple: 1.3 },
        );
      }
    });
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.from(out as ArrayBuffer);
}

/** 把块序列压成一页的要点（标题已在页眉，不重复）。 */
function bulletsOf(blocks: MdBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === "heading") out.push(block.text);
    if (block.kind === "paragraph") out.push(block.text);
    if (block.kind === "bullet" || block.kind === "ordered") out.push(...block.items);
    if (block.kind === "table") {
      out.push(block.header.join(" / "));
      for (const row of block.rows.slice(0, 6)) out.push(row.join(" / "));
    }
  }
  return out.filter((line) => line.trim());
}

/**
 * Markdown → Excel Buffer。
 *
 * @param markdown 正文
 * @param title 工作表名（Excel 的工作表名有 31 字上限，这里会截断）
 * @returns .xlsx 的字节
 */
export async function markdownToXlsx(markdown: string, title: string): Promise<Buffer> {
  const { header, rows } = toTableRows(parseMarkdown(markdown));
  const wb = new ExcelJS.Workbook();
  wb.creator = "工作台";
  // 工作表名不允许 []:*?/\ 且最长 31 字
  const safeSheet = (title || "产物").replace(/[[\]:*?/\\]/g, "-").slice(0, 31) || "产物";
  const sheet = wb.addWorksheet(safeSheet);

  sheet.addRow(header);
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF1F8" } };

  for (const row of rows) {
    // 行长度不齐时补齐，避免 Excel 里列错位
    const padded = [...row];
    while (padded.length < header.length) padded.push("");
    sheet.addRow(padded);
  }

  // 按内容估个列宽（中文按 2 个字符宽算）
  header.forEach((_title: string, index: number) => {
    let widest = 8;
    sheet.eachRow((row) => {
      const cell = row.getCell(index + 1).value;
      const text = cell === null || cell === undefined ? "" : String(cell);
      const width = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
      widest = Math.max(widest, Math.min(width + 2, 60));
    });
    sheet.getColumn(index + 1).width = widest;
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/**
 * 统一入口：按类型把 Markdown 转成对应格式的字节。
 *
 * @param kind 目标格式
 * @param markdown 正文
 * @param title 标题
 * @returns 文件字节
 */
export async function markdownToOffice(kind: OfficeKind, markdown: string, title: string): Promise<Buffer> {
  switch (kind) {
    case "docx":
      return markdownToDocx(markdown, title);
    case "pptx":
      return markdownToPptx(markdown, title);
    case "xlsx":
      return markdownToXlsx(markdown, title);
    default: {
      // 联合类型穷尽；到不了这里
      const never: never = kind;
      throw new Error(`不支持的格式：${String(never)}`);
    }
  }
}
