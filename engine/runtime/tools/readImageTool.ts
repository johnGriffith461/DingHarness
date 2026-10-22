import fs from "node:fs/promises";
import path from "node:path";

import { imageResultFor } from "../../../shared/imageContent";
import { insideDirs } from "./drivePaths";
import { findByFileName } from "./readTool";

/**
 * 「读图片」工具（A-02，2026-10-22）。
 *
 * ## 它解决什么
 *
 * 用户说"按这张设计稿改""截图上的报错是什么"时，agent 只有 `read_file`（读文本）。
 * 图片要么被当成二进制拒掉，要么（更糟）编一段内容。有了这条，图片能**真的给模型看**。
 *
 * ## 边界（如实写进描述里，模型会因此少撞墙）
 *
 * - 只读**用户授权目录**里的文件（与 `read_file` 同一套白名单，调用方传 `resolve` 进来）；
 * - 只认 `png/jpg/jpeg/webp/gif`；**PDF 这一版不解析**（要渲染引擎，见方案 §不做）；
 * - 单张 ≤ 12 MiB（与 `read_file` 的"别把几兆塞进内存"同一条口径）；
 * - 模型不支持看图 → `imageResultFor` 会明说"我看不到"，不假装看过。
 */

export const IMAGE_MAX_BYTES = 12 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export type ReadImageResult =
  | { ok: true; path: string; mime: string; bytes: number; media?: Array<{ mime: string; base64: string }>; note?: string; line: string }
  | { ok: false; error: string };

/**
 * 读一张图片。
 *
 * @param file 已经过路径白名单解析的**绝对路径**
 * @param opts.modelSupportsImage 这一轮的模型能不能看图
 */
export async function readImageForModel(
  file: string,
  opts: { modelSupportsImage: boolean },
): Promise<ReadImageResult> {
  const ext = path.extname(file).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return {
      ok: false,
      error: `只支持 png/jpg/jpeg/webp/gif（这个文件是 ${ext || "没有扩展名"}）；PDF 这一版不解析，先用别的工具取文字`,
    };
  }
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { ok: false, error: `读不到这个文件：${file}` };
  }
  if (!stat.isFile()) return { ok: false, error: `这不是一个文件：${file}` };
  if (stat.size === 0) return { ok: false, error: `这个文件是空的（0 字节）：${file}` };
  if (stat.size > IMAGE_MAX_BYTES) {
    return {
      ok: false,
      error: `图片有 ${Math.round(stat.size / 1024 / 1024)} MiB，超过 ${IMAGE_MAX_BYTES / 1024 / 1024} MiB 上限 —— 先缩小再看`,
    };
  }
  let base64: string;
  try {
    base64 = (await fs.readFile(file)).toString("base64");
  } catch (error) {
    return { ok: false, error: `读不进去：${error instanceof Error ? error.message : String(error)}` };
  }
  const decision = imageResultFor({ path: file, mime, base64, modelSupportsImage: opts.modelSupportsImage });
  if (decision.kind === "path") {
    /* 退化：如实说"看不到"，但**不报错**（文件是读到了，只是模型看不了） */
    return { ok: true, path: file, mime, bytes: stat.size, note: decision.text, line: `读了 ${path.basename(file)}（${Math.round(stat.size / 1024)} KiB）` };
  }
  return {
    ok: true,
    path: file,
    mime,
    bytes: stat.size,
    media: [decision.media],
    line: `读了 ${path.basename(file)}（${Math.round(stat.size / 1024)} KiB，${mime}）`,
  };
}

/**
 * 把用户写的路径解析成**授权目录里的绝对路径**（与 `read_file` 同一套白名单）。
 *
 * 三种写法都支持：绝对路径 / 相对工作目录 / 只给文件名（在授权目录里按名字找）。
 *
 * @returns 绝对路径；解析不到或越界时给一句人话
 */
export async function resolveImagePath(
  raw: string,
  dirs: readonly string[],
): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "path 不能为空" };
  const direct = insideDirs(text, dirs);
  if (direct) return { ok: true, file: direct };
  /* 只给文件名：在授权目录里找（命中多个就让人指定，不猜） */
  const hits = await findByFileName(text, dirs);
  if (hits.length === 1 && hits[0]) return { ok: true, file: hits[0] };
  if (hits.length > 1) {
    return { ok: false, error: `有 ${hits.length} 个同名文件，请给更具体的路径：${hits.slice(0, 5).join(" / ")}` };
  }
  return { ok: false, error: `读不到这个文件（它不在授权目录里）：${text}` };
}
