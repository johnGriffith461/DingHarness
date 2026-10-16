import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { markdownToDocx, markdownToPptx } from "../electron/ipc/officeWrite";

/**
 * Office 导出的**内容不许被静默丢掉**（**审计 P226**）。
 *
 * ## 缺陷形状
 *
 * `markdownToPptx` 里是 `bullets.slice(0, 12)`：第 13 条往后的正文**直接消失**，
 * 而函数照样返回 Buffer、上层照样报「已生成」。长文最容易命中 ——
 * `bestSectionLevel` 在没有标题时返回 1，整篇变成一节一页，于是"一页 12 条"
 * 吃掉了整篇文档的大部分。
 *
 * ## 判据（真产物、真解包）
 *
 * 造一段 15 条要点的 Markdown → 导出 pptx → **解包**数幻灯片、并断言第 15 条
 * 的文本**真的在某一页里**。把 `PPTX_BULLETS_PER_SLIDE` 的分页逻辑改回
 * `slice(0, 12)`，这条会红（最后一页只到第 12 条）。
 */
const bullets = (n: number) =>
  Array.from({ length: n }, (_, i) => `- 第${i + 1}条要点：这一段是对应位置的正文`).join("\n");

/** 解包 pptx，返回每张幻灯片的 XML 拼起来的大字符串。 */
async function slidesText(buf: Buffer): Promise<{ count: number; xml: string }> {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  let xml = "";
  for (const n of names) xml += await zip.files[n]!.async("string");
  return { count: names.length, xml };
}

describe("pptx 导出（P226）", () => {
  it("⭐ 一节 15 条要点：一条都不许丢（超出的另起续页，不是 quietly 扔掉）", async () => {
    const buf = await markdownToPptx(bullets(15), "长文");
    const { count, xml } = await slidesText(buf);
    expect(xml, "第 15 条要点没有出现在产物里 —— 它被静默丢弃了").toContain("第15条要点");
    expect(xml, "第 13 条（原来 slice(0,12) 的第一个受害者）不在产物里").toContain("第13条要点");
    /* 封面 + 至少两页要点 */
    expect(count).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("要点不多时仍是**一节一页**（分页只在超出一页容量时才发生）", async () => {
    const buf = await markdownToPptx(bullets(5), "短");
    const { count, xml } = await slidesText(buf);
    expect(count).toBe(2); // 封面 + 一页
    expect(xml).toContain("第5条要点");
  }, 30_000);

  it("docx 那条不受影响（同一份 Markdown 里每一条都在）", async () => {
    const buf = await markdownToDocx(bullets(15), "长文");
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.files["word/document.xml"]!.async("string");
    expect(xml).toContain("第15条要点");
  }, 30_000);
});
