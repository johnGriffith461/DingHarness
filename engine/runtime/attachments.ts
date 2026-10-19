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

/** 扩展名 → mime（读回时用；`saveAttachment` 那张表反过来再补几个常见的）。 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
};

/**
 * G2：把附件路径收窄到**会话目录内**。
 *
 * 渲染层给的是磁盘路径（不可信）：`../../` 或绝对路径必须被拒，
 * 否则「看缩略图」就变成了任意文件读取。
 *
 * @returns 规范化后的绝对路径；越界返回 null
 */
export function attachmentPathWithin(sessionsDir: string, file: string): string | null {
  if (typeof file !== "string" || !file.trim()) return null;
  const root = path.resolve(sessionsDir);
  const target = path.resolve(file);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

/**
 * G2：读回附件为 data URL（界面缩略图/预览用）。
 *
 * 只读、只允许会话目录内、上限与写入一致（25 MiB）。
 * 文件被清理时返回可读错误，界面显示占位而不是崩。
 */
export async function readAttachmentDataUrl(
  sessionsDir: string,
  file: string,
): Promise<{ ok: true; dataUrl: string; mediaType: string } | { ok: false; error: string }> {
  const target = attachmentPathWithin(sessionsDir, file);
  if (!target) return { ok: false, error: "路径不在会话附件目录内" };
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { ok: false, error: code === "ENOENT" ? "附件已清理" : `读不到（${(error as Error)?.message ?? "未知原因"}）` };
  }
  if (bytes.length > ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: `附件过大（${bytes.length} 字节）` };
  }
  const ext = path.extname(target).replace(/^\./, "").toLowerCase();
  const mediaType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return { ok: true, dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`, mediaType };
}
