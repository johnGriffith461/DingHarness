import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 附件落盘（B3）。
 *
 * 只做一件事：把 base64 的图片/PDF 写进会话私有目录，返回**路径 + 大小 + sha256**。
 * 事件与步骤里只记这些（不记正文），所以旧日志不会因为一张图而膨胀。
 *
 * 边界：
 * - 目标目录由调用方给（内核不读全局路径）；
 * - 文件名由 `randomUUID` 生成，**不用用户给的名字拼路径**（防 `../` 与非法字符）；
 * - 单文件上限 25 MiB；超限拒绝并说清。
 */

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

export type SaveAttachmentInput = {
  /** 会话 id（只允许安全字符；不合法的字符会被换成 `-`）。 */
  sessionId: string;
  name: string;
  mediaType: string;
  /** base64（不带 `data:` 前缀）。 */
  data: string;
};

export type SavedAttachment = {
  ok: true;
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
  name: string;
};

export type SaveAttachmentResult = SavedAttachment | { ok: false; error: string };

function safeSegment(value: string): string {
  return (
    String(value ?? "")
      .replace(/[^A-Za-z0-9._-]/g, "-")
      /* 单个目录名里也不留 `..`：它能逃出目录的写法只有 `..` 作为整段，索性一并抹掉 */
      .replace(/\.{2,}/g, "-")
      .slice(0, 80) || "session"
  );
}

function extensionFor(input: { name: string; mediaType: string }): string {
  const byMime = EXT_BY_MIME[input.mediaType.toLowerCase()];
  if (byMime) return byMime;
  const ext = path.extname(input.name).replace(/^\./, "").toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  return "bin";
}

/**
 * 写一个附件到 `<sessionsDir>/<sessionId>/attachments/<uuid>.<ext>`。
 *
 * @param sessionsDir 会话根目录（宿主给）
 * @param input 会话 id / 原始文件名 / mime / base64
 */
export async function saveAttachment(sessionsDir: string, input: SaveAttachmentInput): Promise<SaveAttachmentResult> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(String(input.data ?? ""), "base64");
  } catch {
    return { ok: false, error: "附件内容不是合法的 base64" };
  }
  if (!bytes.length) return { ok: false, error: "附件是空的" };
  if (bytes.length > ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: `附件过大（${bytes.length} 字节，上限 ${ATTACHMENT_MAX_BYTES}）` };
  }

  const session = safeSegment(input.sessionId);
  const dir = path.join(sessionsDir, session, "attachments");
  const file = path.join(dir, `${randomUUID()}.${extensionFor(input)}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, bytes);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return {
    ok: true,
    path: file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mediaType: input.mediaType,
    name: String(input.name ?? "").slice(0, 200) || path.basename(file),
  };
}
