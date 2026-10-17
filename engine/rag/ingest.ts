import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { AddDocumentInput, KnowledgeDomain, KnowledgeStore } from "./store";

/**
 * 文档入库（V6-3e）。
 *
 * 支持：`.md` / `.markdown` / `.txt` / `.json` / `.csv` / `.log` / `.docx`，
 * 以及**本机有 `pdftotext` 时**的 `.pdf`。
 *
 * 不支持的格式**明确报错**，不"尽力而为"地塞二进制：把 PDF 的乱码索引进去，
 * 检索会命中一堆不可读的片段 —— 那比不索引更坏。
 */

/** 可以直接读文本的扩展名。 */
const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".json", ".csv", ".tsv", ".log", ".yaml", ".yml", ".html", ".htm"]);

/** 目录递归时认哪些（PDF 也在内，但有额外前置条件）。 */
export const INGEST_EXT = new Set([...TEXT_EXT, ".docx", ".pdf"]);

/** DOCX 里那一段 XML → 纯文本。 */
export function docxXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 从文件里抽正文。
 *
 * @param file 绝对路径
 * @returns 正文与标题（标题默认文件名）
 */
export async function extractText(file: string): Promise<{ text: string; title: string }> {
  const ext = path.extname(file).toLowerCase();
  const title = path.basename(file);
  if (TEXT_EXT.has(ext)) {
    return { text: fs.readFileSync(file, "utf8"), title };
  }
  if (ext === ".docx") {
    /*
     * DOCX 是一个 zip：只读 `word/document.xml` 就够（正文都在那里）。
     * `jszip` 是直接依赖（package.json 里钉着版本），不靠传递依赖。
     */
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const entry = zip.file("word/document.xml");
    if (!entry) throw new Error("这个 .docx 里没有 word/document.xml（不是 Word 文档？）");
    const text = docxXmlToText(await entry.async("string"));
    if (!text.trim()) throw new Error("这个 .docx 没有可提取的文字（可能是扫描件/纯图片）");
    return { text, title };
  }
  if (ext === ".pdf") {
    const got = spawnSync("pdftotext", [file, "-"], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
    if (got.error) {
      throw new Error(
        "这台机器没有 `pdftotext`（poppler-utils）：PDF 需要它才能抽文字。装一个，或先把 PDF 另存为 txt/md 再入库。",
      );
    }
    if (got.status !== 0) throw new Error(`pdftotext 失败：${String(got.stderr ?? "").slice(0, 160)}`);
    const text = String(got.stdout ?? "");
    if (!text.trim()) throw new Error("这个 PDF 没有可提取的文字（扫描件需要先 OCR）");
    return { text, title };
  }
  throw new Error(`不支持的格式：${ext || "(无扩展名)"}（支持 ${[...INGEST_EXT].join(" / ")}）`);
}

/** 一次入库的结果。 */
export type IngestResult = {
  /** 成功入库的文档（路径 + 段数）。 */
  added: { path: string; chunks: number; replaced: boolean }[];
  /** 跳过的（不支持 / 读不了），带原因。 */
  skipped: { path: string; reason: string }[];
};

/** 递归找可入库的文件（跳过 node_modules/.git 与隐藏目录）。 */
function collectFiles(target: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && INGEST_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  const stat = fs.statSync(target);
  if (stat.isDirectory()) walk(target);
  else out.push(target);
  return out;
}

/**
 * 把文件/目录灌进知识库。
 *
 * @param store 知识库
 * @param target 文件或目录
 * @param opts 域与归属
 * @returns 入库与跳过清单（**不抛**：一条读不了不该带走整批）
 */
export async function ingestPath(
  store: KnowledgeStore,
  target: string,
  opts: { domain?: KnowledgeDomain; owner?: string } = {},
): Promise<IngestResult> {
  const absolute = path.resolve(target);
  if (!fs.existsSync(absolute)) throw new Error(`路径不存在：${absolute}`);
  const added: IngestResult["added"] = [];
  const skipped: IngestResult["skipped"] = [];
  for (const file of collectFiles(absolute)) {
    try {
      const { text, title } = await extractText(file);
      const input: AddDocumentInput = {
        path: file,
        title,
        text,
        ...(opts.domain ? { domain: opts.domain } : {}),
        ...(opts.owner ? { owner: opts.owner } : {}),
      };
      const { doc, replaced } = store.addDocument(input);
      added.push({ path: file, chunks: doc.chunks, replaced });
    } catch (error) {
      skipped.push({ path: file, reason: String((error as Error)?.message ?? error).slice(0, 200) });
    }
  }
  return { added, skipped };
}
