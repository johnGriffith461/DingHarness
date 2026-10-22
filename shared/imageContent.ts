/**
 * **图片内容块的决定**（A-01，2026-10-22）。
 *
 * 七个 GUI 工具（浏览器/computer use）以前都只回一个文件路径 —— 模型全程看不见图。
 * 这里把"这张图要不要当成图片给模型、还是退化成一句话"做成一个纯函数，集中一处：
 *
 * - 模型支持图片 → 给内容块；
 * - 模型不支持 → **如实说"我看不到"**，并给出下一步（换模型），不许假装看过；
 * - 太大 → 调用方先缩小再进来（这个函数只做**判断**，不做图像处理 —— 缩放要 sharp/canvas，
 *   在主进程那侧按 `maxBytes` 处理）。
 */

/** 缺省的图片大小上限（字节）。超过就应由调用方缩小，而不是截断 base64。 */
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

export type ImageDecision =
  | { kind: "image"; media: { mime: string; base64: string } }
  | { kind: "path"; text: string };

/**
 * @param input.path 图片文件路径（退化时写进那句话里）
 * @param input.mime mime（`image/png` 等）
 * @param input.base64 图片字节（不带 `data:` 前缀）
 * @param input.modelSupportsImage 这一轮的模型能不能看图（唯一来源：`capabilityOf`/模型配置的 `inputFormat`）
 * @param input.maxBytes 上限（默认 1.5 MiB）
 */
export function imageResultFor(input: {
  path: string;
  mime: string;
  base64: string;
  modelSupportsImage: boolean;
  maxBytes?: number;
}): ImageDecision {
  const max = input.maxBytes ?? MAX_IMAGE_BYTES;
  if (!input.modelSupportsImage) {
    return {
      kind: "path",
      text: `已存到 ${input.path}，但当前模型不支持看图，我看不到内容。可以换一个支持图片的模型。`,
    };
  }
  if (!input.base64) {
    return { kind: "path", text: `${input.path} 是空的（0 字节），没有内容可以看。` };
  }
  /* ⚠️ 超限不截断 base64（截断的图解码会失败，模型只会看到一张坏图）——交给调用方缩小 */
  const bytes = Math.floor((input.base64.length * 3) / 4);
  if (bytes > max) {
    return {
      kind: "path",
      text: `${input.path} 有 ${Math.round(bytes / 1024)} KiB，超过 ${Math.round(max / 1024)} KiB 上限；调用方应缩小后再给模型（不截断）。`,
    };
  }
  return { kind: "image", media: { mime: input.mime, base64: input.base64 } };
}
