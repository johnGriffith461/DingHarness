import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readImageForModel } from "./readImageTool";

/**
 * A-02：read_image。
 *
 * 判据：支持图片 → media 里有 base64 与正确 mime；不支持 → 明说"看不到"但**不报错**；
 * 非法类型/空文件/超大 → 如实拒（各一句人话）。
 */
const dirs: string[] = [];
const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
function tempFile(name: string, body: Buffer | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readimg-"));
  dirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("read_image", () => {
  it("png + 支持图片 → media 带 mime 与 base64", async () => {
    const file = tempFile("a.png", png1x1);
    const got = await readImageForModel(file, { modelSupportsImage: true });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.mime).toBe("image/png");
    expect(got.media?.[0]?.mime).toBe("image/png");
    expect(got.media?.[0]?.base64).toBe(png1x1.toString("base64"));
  });

  it("⭐ 模型不支持图片 → 明说看不到，但不是错误", async () => {
    const file = tempFile("a.png", png1x1);
    const got = await readImageForModel(file, { modelSupportsImage: false });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.media).toBeUndefined();
    expect(got.note).toContain("我看不到");
  });

  it("PDF / 未知扩展名 → 如实拒并说清", async () => {
    const file = tempFile("a.pdf", "%PDF-1.4");
    const got = await readImageForModel(file, { modelSupportsImage: true });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain("PDF");
  });

  it("空文件 → 拒（不假装有内容）", async () => {
    const file = tempFile("empty.png", "");
    const got = await readImageForModel(file, { modelSupportsImage: true });
    expect(got.ok).toBe(false);
  });
});
