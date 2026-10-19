import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_MAX_BYTES, saveAttachment } from "./attachments";

/**
 * B3：附件落盘的边界。
 * 挡的是"用户给的文件名拼进路径"（`../../x`）与"大文件静默撑爆磁盘"。
 */

let dir: string;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ding-attachments-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("saveAttachment", () => {
  it("写到 sessions/<sessionId>/attachments/，返回大小与 sha256", async () => {
    const got = await saveAttachment(dir, {
      sessionId: "task-1",
      name: "shot.png",
      mediaType: "image/png",
      data: png.toString("base64"),
    });

    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.path).toContain(path.join("task-1", "attachments"));
    expect(path.extname(got.path)).toBe(".png");
    expect(got.bytes).toBe(png.length);
    expect(got.sha256).toHaveLength(64);
    expect(fs.readFileSync(got.path)).toEqual(png);
  });

  it("同名两次得到不同文件（文件名由 uuid 生成）", async () => {
    const a = await saveAttachment(dir, { sessionId: "s", name: "a.png", mediaType: "image/png", data: png.toString("base64") });
    const b = await saveAttachment(dir, { sessionId: "s", name: "a.png", mediaType: "image/png", data: png.toString("base64") });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.path).not.toBe(b.path);
  });

  it("⭐ 会话 id 与文件名里的路径字符不会逃出附件目录", async () => {
    const got = await saveAttachment(dir, {
      sessionId: "../../etc",
      name: "../../evil.png",
      mediaType: "image/png",
      data: png.toString("base64"),
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const attachmentsRoot = path.resolve(dir);
    expect(path.resolve(got.path).startsWith(attachmentsRoot + path.sep)).toBe(true);
    expect(got.path).not.toContain("..");
  });

  it("PDF 扩展名按 mime 走", async () => {
    const got = await saveAttachment(dir, {
      sessionId: "s",
      name: "noext",
      mediaType: "application/pdf",
      data: Buffer.from("%PDF-1.4").toString("base64"),
    });
    expect(got.ok && path.extname(got.path)).toBe(".pdf");
  });

  it("空内容与超限被拒", async () => {
    expect((await saveAttachment(dir, { sessionId: "s", name: "a.png", mediaType: "image/png", data: "" })).ok).toBe(false);
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 1).toString("base64");
    const got = await saveAttachment(dir, { sessionId: "s", name: "big.png", mediaType: "image/png", data: big });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("过大");
  });
});
