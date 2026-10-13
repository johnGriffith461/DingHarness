/**
 * 极简 Markdown 块解析（阶段 11.2）。
 *
 * 产物要落成**真格式**：`.docx` / `.pptx` / `.xlsx`。往这些扩展名里写 Markdown 文本
 * 会产出打不开的坏文件 —— 必须真的构造格式。
 *
 * 三种格式吃的是同一份结构，所以先把 Markdown 解析成一小撮块级节点，
 * 再由各格式的转换器各自消费。刻意保持**极简**：只认标题、列表、表格、段落、代码块，
 * 够用且可离线验证；不追求完整 CommonMark（那需要一整个依赖，收益不成比例）。
 */

/** 块级节点。 */
export type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; items: string[] }
  | { kind: "ordered"; items: string[] }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "table"; header: string[]; rows: string[][] };

/** 一个列表项：`- x` / `* x` / `1. x` / `1) x` / `1、x`。 */
const BULLET_RE = /^\s*[-*·•]\s+(.*)$/;
/**
 * 有序列表项。
 *
 * 中文习惯的 `1、甲` **编号后没有空格**，所以不能说"编号后必须有空白"。
 * 但也不能放宽成"编号后随便跟什么" —— 那样 `1.5 倍`、`2024年` 都会被当成列表。
 * 折中：`、` 与 `)` 后允许无空格（中文/括号写法），` .` 后必须跟空白。
 */
const ORDERED_RE = /^\s*\d+(?:[、)]\s*|[.]\s+)(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** 把一行拆成表格单元格（去掉首尾的空 `|`）。 */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** 表格的分隔行：`|---|:--:|` 这种。 */
export function isTableDivider(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c) || /^:-*$/.test(c) || /^-*:$/.test(c));
}

/** 去掉行内的 Markdown 强调标记（`**粗**` → `粗`），留给各格式自己决定样式。 */
export function stripInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

/** 行内是否整体加粗（`**x**`）。 */
export function isBold(text: string): boolean {
  return /^\s*\*\*.+\*\*\s*$/.test(text) || /^\s*__.+__\s*$/.test(text);
}

/**
 * 解析成块序列。
 *
 * @param markdown 原文
 * @returns 块数组；空输入返回空数组
 */
export function parseMarkdown(markdown: string): MdBlock[] {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  /** 把连续的普通行并成一段。 */
  const flushParagraph = (buffer: string[]) => {
    if (buffer.length === 0) return;
    blocks.push({ kind: "paragraph", text: buffer.join(" ").trim() });
    buffer.length = 0;
  };

  let paragraph: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行 = 段落分隔
    if (!trimmed) {
      flushParagraph(paragraph);
      i += 1;
      continue;
    }

    // 代码块
    const fence = /^```(\w*)/.exec(trimmed);
    if (fence) {
      flushParagraph(paragraph);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 吃掉收尾的 ```
      blocks.push({ kind: "code", lang: fence[1] ?? "", lines: body });
      continue;
    }

    // 标题
    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      flushParagraph(paragraph);
      blocks.push({ kind: "heading", level: heading[1].length, text: stripInline(heading[2]) });
      i += 1;
      continue;
    }

    // 表格：当前行有 `|` 且下一行是分隔行
    if (trimmed.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushParagraph(paragraph);
      const header = splitRow(trimmed).map(stripInline);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]).map(stripInline));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // 无序列表
    if (BULLET_RE.test(line)) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (i < lines.length && BULLET_RE.test(lines[i])) {
        items.push(stripInline(BULLET_RE.exec(lines[i])![1]));
        i += 1;
      }
      blocks.push({ kind: "bullet", items });
      continue;
    }

    // 有序列表
    if (ORDERED_RE.test(line)) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (i < lines.length && ORDERED_RE.test(lines[i])) {
        items.push(stripInline(ORDERED_RE.exec(lines[i])![1]));
        i += 1;
      }
      blocks.push({ kind: "ordered", items });
      continue;
    }

    // 段落也要过 stripInline —— 漏掉这一步的话 `**粗**` 会原样带进产物里
    paragraph.push(stripInline(trimmed));
    i += 1;
  }

  flushParagraph(paragraph);
  return blocks;
}

/**
 * 把块序列按标题切成"分节"，给 PPT 一页一张用。
 *
 * 规则：遇到 level ≤ `level` 的标题就开新节；节内如果没有标题，就用首段文字当节标题。
 *
 * @param blocks 块数组
 * @param level 切到第几级标题（默认 1）
 * @returns 每节一个 `{ title, blocks }`
 */
export function splitSections(blocks: MdBlock[], level = 1): Array<{ title: string; blocks: MdBlock[] }> {
  const sections: Array<{ title: string; blocks: MdBlock[] }> = [];
  let current: { title: string; blocks: MdBlock[] } | null = null;

  for (const block of blocks) {
    if (block.kind === "heading" && block.level <= level) {
      if (current) sections.push(current);
      current = { title: block.text, blocks: [] };
      continue;
    }
    if (!current) current = { title: "", blocks: [] };
    current.blocks.push(block);
  }
  if (current) sections.push(current);

  // 没标题的节用首段兜底；实在没内容就留空（转换器会给个默认标题）
  return sections.map((section) => {
    if (section.title) return section;
    const first = section.blocks.find((b) => b.kind === "paragraph" || b.kind === "bullet");
    const text =
      first && first.kind === "paragraph"
        ? first.text
        : first && first.kind === "bullet"
          ? (first.items[0] ?? "")
          : "";
    return { title: text.slice(0, 40), blocks: section.blocks };
  });
}

/**
 * 挑一个"能分出多页"的标题级别（给 PPT 分页用）。
 *
 * 为什么需要它：按一级标题一页是**想当然**的 —— 实测一份典型文档只有一个
 * `#`（文档名），正文全是 `##`。照这个规则切，整篇只会得到**一页**，
 * 那就不是一份能用的演示文稿了。
 *
 * 所以改成：从第 1 级往下试，**取第一个能切出 ≥2 节的级别**；
 * 都不行就退回第 1 级（此时确实只有一节，一页也合理）。
 *
 * @param blocks 块数组
 * @param maxLevel 最多试到第几级（默认 3）
 * @returns 适合分页的标题级别
 */
export function bestSectionLevel(blocks: MdBlock[], maxLevel = 3): number {
  for (let level = 1; level <= maxLevel; level += 1) {
    if (splitSections(blocks, level).length >= 2) return level;
  }
  return 1;
}

/**
 * 把块序列压成表格的行（给 xlsx 用）。
 *
 * 优先用文档里的**表格块**；一个都没有时，把「要点」行按 `冒号` 拆成两列，
 * 让导出的表格至少是有结构的，而不是一列长文本。
 *
 * @param blocks 块数组
 * @returns `{ header, rows }`；header 可能为空
 */
export function toTableRows(blocks: MdBlock[]): { header: string[]; rows: string[][] } {
  const tables = blocks.filter((b): b is Extract<MdBlock, { kind: "table" }> => b.kind === "table");
  if (tables.length > 0) {
    const first = tables[0];
    const rows = [...first.rows];
    for (const extra of tables.slice(1)) rows.push(...extra.rows);
    return { header: first.header, rows };
  }

  const rows: string[][] = [];
  for (const block of blocks) {
    if (block.kind === "bullet" || block.kind === "ordered") {
      for (const item of block.items) {
        const m = /^(.{1,24}?)[：:]\s*(.*)$/.exec(item);
        if (m) rows.push([m[1], m[2]]);
        else rows.push([item]);
      }
    }
    if (block.kind === "heading") rows.push([block.text]);
  }
  return { header: rows.some((r) => r.length > 1) ? ["项目", "内容"] : ["内容"], rows };
}
