import type { ImageCrop } from "../types";

/**
 * 图片裁剪换算（纯逻辑，可单测）。
 *
 * 数据模型对标原版：节点 data 里存**原图坐标的裁剪框**，而不是裁好的位图 ——
 * 这样快照体积小、可反复调整、也不会因为字体缩放导致图片被反复重采样。
 * 展示时用 CSS 把裁剪框映射成 `object-position` + 尺寸。
 */

/** react-easy-crop 的裁剪结果（百分比，相对原图显示区）。 */
export type PercentCrop = { x: number; y: number; width: number; height: number };

/** 已知原图尺寸时，把百分比裁剪换算成像素裁剪。 */
export function percentToCrop(percent: PercentCrop, natural: { width: number; height: number }): ImageCrop {
  return {
    x: Math.round((percent.x / 100) * natural.width),
    y: Math.round((percent.y / 100) * natural.height),
    width: Math.round((percent.width / 100) * natural.width),
    height: Math.round((percent.height / 100) * natural.height),
  };
}

/** 把像素裁剪换算回百分比（react-easy-crop 的初始值要这个）。 */
export function cropToPercent(crop: ImageCrop, natural: { width: number; height: number }): PercentCrop {
  return {
    x: (crop.x / natural.width) * 100,
    y: (crop.y / natural.height) * 100,
    width: (crop.width / natural.width) * 100,
    height: (crop.height / natural.height) * 100,
  };
}

/** 裁剪框是否等于整图（等于整图时不值得展示"已裁剪"）。 */
export function isFullCrop(crop: ImageCrop | undefined, natural: { width: number; height: number } | undefined): boolean {
  if (!crop || !natural) return true;
  return (
    crop.x <= 1 &&
    crop.y <= 1 &&
    crop.width >= natural.width - 2 &&
    crop.height >= natural.height - 2
  );
}

/** 裁剪框的合法化：夹到原图范围内，且至少 1px。 */
export function clampCrop(crop: ImageCrop, natural: { width: number; height: number }): ImageCrop {
  const x = Math.max(0, Math.min(crop.x, natural.width - 1));
  const y = Math.max(0, Math.min(crop.y, natural.height - 1));
  const width = Math.max(1, Math.min(crop.width, natural.width - x));
  const height = Math.max(1, Math.min(crop.height, natural.height - y));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * 展示用的样式：把原图按裁剪框"对位"放进容器。
 * 用 `object-fit: cover` + 负向 object-position 等价实现，
 * 避免每个节点都要画一次 canvas。
 */
export function cropStyle(crop: ImageCrop | undefined, natural: { width: number; height: number } | undefined): Record<string, string> {
  if (!crop || !natural || isFullCrop(crop, natural)) return {};
  const scaleX = (natural.width / crop.width) * 100;
  const scaleY = (natural.height / crop.height) * 100;
  return {
    width: `${scaleX}%`,
    height: `${scaleY}%`,
    objectFit: "fill",
    transform: `translate(${(-crop.x / natural.width) * 100}%, ${(-crop.y / natural.height) * 100}%)`,
  };
}

/**
 * 把裁剪后的位图导出成 dataURL（用于"裁剪后固化"或后续落盘）。
 * 纯函数式接口，便于测试时喂假数据。
 */
export async function exportCroppedDataUrl(
  image: { src: string; width: number; height: number },
  crop: ImageCrop,
  type = "image/png",
): Promise<string> {
  const img = await loadImage(image.src);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, crop.width);
  canvas.height = Math.max(1, crop.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return canvas.toDataURL(type);
}

/** 读一张图片的原始尺寸。 */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

/** 文件 → dataURL。 */
export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}
