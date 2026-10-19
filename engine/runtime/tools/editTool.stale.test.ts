import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { editFileForModel, statFingerprint } from "./editTool";

/**
 * D3：读后写校验。
 * 判据：文件在读取后被外部改过 → 编辑被拒、文件一个字不变；
 * 没有读记录（expected 未给）→ 不做判定（旧调用零改动）。
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ding-stale-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, "utf8");
  return file;
}

describe("editFileForModel 的 stale 判定", () => {
  it("⭐ 读取之后文件被外部改 → 拒绝编辑，文件不变", async () => {
    const file = write("a.ts", "const a = 1;\n");
    const expected = await statFingerprint(file);
    /* 模拟别人（另一个编辑器/另一个会话）改了这个文件 */
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, "const a = 99; // someone else\n", "utf8");

    const result = await editFileForModel("a.ts", "const a = 1;", "const a = 2;", [dir], false, expected);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("stale");
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 99; // someone else\n");
  });

  it("指纹一致时正常编辑", async () => {
    const file = write("a.ts", "const a = 1;\n");
    const expected = await statFingerprint(file);

    const result = await editFileForModel("a.ts", "const a = 1;", "const a = 2;", [dir], false, expected);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 2;\n");
  });

  it("不给 expected 时行为与以前一样（不做判定）", async () => {
    const file = write("a.ts", "const a = 1;\n");
    const result = await editFileForModel("a.ts", "const a = 1;", "const a = 3;", [dir]);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 3;\n");
  });
});
