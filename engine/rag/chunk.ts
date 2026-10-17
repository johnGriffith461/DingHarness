/**
 * 文档切块（V6-3e）。
 *
 * ## 为什么按"段落打包"而不是固定 512 token
 *
 * 固定长度切会把一句话、一张表的表头切到两个块里 —— 检索命中后拿到的引用
 * 读不通，用户会以为知识库坏了。这里优先按空行分段，再**打包**到接近上限；
 * 只有单个段落本身就超长时才硬切（并带一小段重叠，避免跨界语义完全断掉）。
 */

/** 一块的目标字符数（中文约 900 字 ≈ 600–900 token，看混排）。 */
export const CHUNK_CHARS = 900;

/** 硬切时的重叠字符数（只在超长段落上发生）。 */
export const CHUNK_OVERLAP = 120;

export type TextChunk = {
  /** 0 基序号（引用里显示 1 基）。 */
  ordinal: number;
  text: string;
};

/**
 * 把一段文本切成块。
 *
 * @param raw 原文（CRLF 会被归一）
 * @returns 块（空文本给空数组；不产生空块）
 */
export function chunkText(raw: string): TextChunk[] {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  let buf = "";

  const flush = () => {
    const value = buf.trim();
    if (value) pieces.push(value);
    buf = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_CHARS) {
      flush();
      /* 超长段落：先按行切，再按字符硬切（带重叠） */
      let rest = paragraph;
      while (rest.length > CHUNK_CHARS) {
        const slice = rest.slice(0, CHUNK_CHARS);
        pieces.push(slice.trim());
        rest = rest.slice(CHUNK_CHARS - CHUNK_OVERLAP);
      }
      if (rest.trim()) buf = rest;
      continue;
    }
    if (buf && buf.length + paragraph.length + 2 > CHUNK_CHARS) flush();
    buf = buf ? `${buf}\n\n${paragraph}` : paragraph;
  }
  flush();

  return pieces.map((value, ordinal) => ({ ordinal, text: value }));
}
