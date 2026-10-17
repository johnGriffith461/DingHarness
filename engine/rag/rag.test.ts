import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CHUNK_CHARS, chunkText } from "./chunk";
import { docxXmlToText, extractText, ingestPath } from "./ingest";
import { openKnowledgeStore, type KnowledgeStore } from "./store";

/**
 * 本地知识库（V6-3e）。
 *
 * 守四件事：
 *   ① 切块可读（不把一段话/一张表切碎）；
 *   ② 检索**带引用**（标题 + 路径 + 第几段），用户能回原文核对；
 *   ③ 私有域**检索层就过滤**（不是搜出来再藏 —— 那会把别人的私有内容送进模型上下文）；
 *   ④ 不支持的格式明确报错（不把乱码索引进去）。
 */

const dirs: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-rag-"));
  dirs.push(dir);
  return dir;
}

function store(): KnowledgeStore {
  const s = openKnowledgeStore(tmp());
  stores.push(s);
  return s;
}

describe("切块", () => {
  it("按段落打包到接近上限，不产生空块", () => {
    const text = Array.from({ length: 12 }, (_, i) => `第 ${i} 段：这是一些内容。`).join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
    expect(chunks.every((c) => c.text.length <= CHUNK_CHARS + 10)).toBe(true);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it("超长段落硬切且带重叠（跨界语义不完全断掉）", () => {
    const chunks = chunkText("甲".repeat(CHUNK_CHARS * 2 + 50));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    /* 相邻块有重叠：前一块的尾部能在后一块开头找到 */
    const tail = chunks[0]!.text.slice(-40);
    expect(chunks[1]!.text.startsWith(tail.slice(0, 20))).toBe(true);
  });

  it("空文本给空数组（不塞一个空块）", () => {
    expect(chunkText("   \n\n ")).toEqual([]);
  });
});

describe("检索与引用", () => {
  it("中文子串命中，引用带路径与段号", () => {
    const s = store();
    s.addDocument({ path: "C:/docs/q1.md", title: "第一季度", text: "第一季度营收 120 万，成本 80 万。" });
    s.addDocument({ path: "C:/docs/q2.md", title: "第二季度", text: "第二季度营收 150 万。" });

    const hits = s.search("营收", { viewer: "local", limit: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.citation).toContain("第 1 段");
    expect(hits.some((h) => h.path.endsWith("q1.md") && h.text.includes("120"))).toBe(true);
    expect(hits.some((h) => h.path.endsWith("q2.md") && h.text.includes("150"))).toBe(true);
  });

  it("英文按词命中；空查询给空结果（不是全部）", () => {
    const s = store();
    s.addDocument({ path: "a.txt", title: "notes", text: "The quarterly revenue was strong." });
    expect(s.search("revenue", { viewer: "local" })).toHaveLength(1);
    expect(s.search("   ", { viewer: "local" })).toEqual([]);
  });

  it("⭐ 私有域在检索层过滤：别人的私有文档搜不到，团队域可见", () => {
    const s = store();
    s.addDocument({ path: "bob-private.md", title: "bob 的私人笔记", text: "只有 bob 能看的秘密代号 ZEBRA-42", owner: "bob", domain: "private" });
    s.addDocument({ path: "team.md", title: "团队周报", text: "团队共享：本周代号 ZEBRA-42 的进展", owner: "bob", domain: "team" });

    const local = s.search("ZEBRA-42", { viewer: "local" });
    expect(local.some((h) => h.path.endsWith("bob-private.md"))).toBe(false);
    expect(local.some((h) => h.path.endsWith("team.md"))).toBe(true);

    const bob = s.search("ZEBRA-42", { viewer: "bob" });
    expect(bob.some((h) => h.path.endsWith("bob-private.md"))).toBe(true);

    expect(s.list("local").some((d) => d.path.endsWith("bob-private.md"))).toBe(false);
  });

  it("同一路径重灌：替换旧文档，不留两份", () => {
    const s = store();
    s.addDocument({ path: "same.md", title: "旧", text: "旧内容 ALPHA" });
    const again = s.addDocument({ path: "same.md", title: "新", text: "新内容 BETA" });
    expect(again.replaced).toBe(true);
    expect(s.list("local")).toHaveLength(1);
    expect(s.search("ALPHA", { viewer: "local" })).toEqual([]);
    expect(s.search("BETA", { viewer: "local" })).toHaveLength(1);
  });

  it("删除：按路径与按 id 都行", () => {
    const s = store();
    const { doc } = s.addDocument({ path: "gone.md", title: "x", text: "要被删掉的内容" });
    expect(s.removeDocument("gone.md").removed).toBeGreaterThan(0);
    expect(s.search("删掉", { viewer: "local" })).toEqual([]);
    const second = s.addDocument({ path: "gone2.md", title: "y", text: "另一份" });
    expect(s.removeDocument(second.doc.id).removed).toBeGreaterThan(0);
    expect(s.list("local")).toEqual([]);
    expect(doc.id).toBeTruthy();
  });
});

describe("入库", () => {
  it("DOCX：从 word/document.xml 抽正文（段落换行、实体解码）", async () => {
    const dir = tmp();
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<w:document><w:body><w:p><w:r><w:t>季度营收 120 万</w:t></w:r></w:p><w:p><w:r><w:t>A &amp; B</w:t></w:r></w:p></w:body></w:document>`,
    );
    const file = path.join(dir, "报告.docx");
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));

    const { text } = await extractText(file);
    expect(text).toContain("季度营收 120 万");
    expect(text).toContain("A & B");
    expect(text).toContain("\n");

    const s = store();
    const result = await ingestPath(s, file, { domain: "team" });
    expect(result.added).toHaveLength(1);
    expect(s.search("季度营收", { viewer: "local" })[0]?.citation).toContain("报告.docx");
    expect(docxXmlToText("<w:p><w:t>x</w:t></w:p>")).toBe("x");
  });

  it("目录递归：只收支持的扩展名；不支持的单文件明确报错", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "a.md"), "# 标题\n\n正文", "utf8");
    fs.writeFileSync(path.join(dir, "sub", "b.txt"), "第二条正文", "utf8");
    fs.writeFileSync(path.join(dir, "skip.exe"), "binary", "utf8");

    const s = store();
    const result = await ingestPath(s, dir);
    expect(result.added).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    expect(s.list("local")).toHaveLength(2);

    await expect(extractText(path.join(dir, "skip.exe"))).rejects.toThrow(/不支持的格式/);
  });
});
