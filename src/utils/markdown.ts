import DOMPurify from "dompurify";
import { spacingLines } from "./spacing";

/**
 * 轻量 Markdown 渲染器（文本节点与思维导图预览共用）。
 *
 * 为什么不用 markdown-it / remark：这里只需要"看板卡片"级别的排版（标题、列表、
 * 粗斜体、行内代码、代码块、引用、链接、分割线）。自己实现能保证输出是**构造安全**的
 * HTML（所有文本先转义，再拼标签），并且能在 node 环境里单测。
 *
 * 语义上对标原版文本节点的"编辑态 / 预览态"两态，预览态还会过 pangu 中英混排
 * （HANDOFF §6.5）。
 */

/** 允许出现的标签白名单（构造安全之外的兜底，DOM 不可用时用正则剥标签）。 */
const ALLOWED_INLINE = ["strong", "em", "code", "del", "a", "br", "mark"];
const ALLOWED_BLOCK = ["h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "pre", "blockquote", "hr"];

/** HTML 转义：所有用户文本都要先过这一层，才能安全地拼进标签。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 行内语法：`code`、**粗**、*斜*、~~删~~、[文字](链接)。 */
function renderInline(raw: string): string {
  let out = escapeHtml(raw);

  // 行内代码优先，避免里面的 * 被当成强调
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/==([^=]+)==/g, "<mark>$1</mark>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
    );

  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? "");
}

/** 首尾去标签 / 保留受限标签的兜底清理（DOM 不可用时使用）。 */
function stripUnsafe(html: string): string {
  const allowed = new Set([...ALLOWED_INLINE, ...ALLOWED_BLOCK]);
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (match, tag: string, attrs: string) => {
    const name = tag.toLowerCase();
    if (!allowed.has(name)) return "";
    if (match.startsWith("</")) return `</${name}>`;
    // 只保留 a 的 href（且必须是 http/https）与 target/rel
    if (name === "a") {
      const href = /href="(https?:\/\/[^"]*)"/i.exec(attrs)?.[1];
      if (!href) return "";
      return `<a href="${href}" target="_blank" rel="noreferrer noopener">`;
    }
    return `<${name}>`;
  });
}

/**
 * 消毒渲染结果。浏览器里走 DOMPurify；node 环境（单测）走白名单剥离。
 * @param html 构造出来的 HTML
 */
export function sanitize(html: string): string {
  const purify = DOMPurify as unknown as { sanitize?: (h: string, o?: unknown) => string };
  if (typeof purify.sanitize === "function") {
    try {
      return purify.sanitize(html, {
        ALLOWED_TAGS: [...ALLOWED_INLINE, ...ALLOWED_BLOCK],
        ALLOWED_ATTR: ["href", "target", "rel"],
      });
    } catch {
      return stripUnsafe(html);
    }
  }
  return stripUnsafe(html);
}

/** 把行数组按块组装成 HTML。 */
function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾的 ```
      out.push(
        `<pre data-lang="${escapeHtml(lang)}"><code>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(body)}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 普通段落（连续非空行合并，单换行按软回车处理）
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    ) {
      body.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${body.map(renderInline).join("<br />")}</p>`);
  }

  return out.join("");
}

export type RenderMarkdownOptions = {
  /** 是否过 pangu 中英混排（预览态默认开）。 */
  spacing?: boolean;
  /** 是否做 HTML 消毒（默认做）。 */
  sanitize?: boolean;
};

/**
 * 渲染 Markdown 为 HTML。
 * @param markdown 原文
 * @param options 同 `RenderMarkdownOptions`
 * @returns 可直接交给 `dangerouslySetInnerHTML` 的安全 HTML
 */
export function renderMarkdown(markdown: string, options: RenderMarkdownOptions = {}): string {
  const { spacing = true, sanitize: doSanitize = true } = options;
  const source = spacing ? spacingLines(markdown) : markdown;
  const html = renderBlocks(source.split("\n"));
  return doSanitize ? sanitize(html) : html;
}

/**
 * 从 Markdown 大纲提取标题树，供思维导图节点构造数据（markmap 也吃 Markdown，
 * 这里只用于"节点内显示的层级摘要"与空态判断）。
 */
export function outlineDepth(markdown: string): number {
  let max = 0;
  for (const line of markdown.split("\n")) {
    const match = /^(#{1,6})\s+/.exec(line);
    if (match) max = Math.max(max, match[1].length);
    else if (/^\s*[-*+]\s+/.test(line)) max = Math.max(max, 2);
  }
  return max;
}
