import type { ShellBridge } from "@shared/ipc";
import { humanFailure } from "@shared/errors";

/**
 * 图像生成客户端（对标原版 `aiCreation_canvas_toolbar_imageGenerator`）。
 *
 * 薄薄一层：桥在不在、错误怎么变成人话，都在这里收口，
 * 界面只管"点了 → 等 → 出图/报错"。
 */

export type ImageModelInfo = {
  id: string;
  label: string;
  models: string[];
  note: string;
};

export type GenerateImageOutcome =
  | { ok: true; name: string; url: string; bytes: number; ms: number; model: string; size?: string }
  | { ok: false; error: string };

function bridge(): ShellBridge | undefined {
  return (window as unknown as { shell?: ShellBridge }).shell;
}

/** 桥是否可用（浏览器里跑就没有）。 */
export function imageBridgeReady(): boolean {
  return typeof bridge()?.image?.generate === "function";
}

/** 列出可用图像模型；桥不可用或没有通道时返回空数组（界面据此提示）。 */
export async function listImageModels(): Promise<ImageModelInfo[]> {
  const shell = bridge();
  if (!shell?.image) return [];
  try {
    return await shell.image.listModels();
  } catch {
    return [];
  }
}

/**
 * 生成一张图。
 * @param prompt 提示词
 * @param model 模型（省略用第一个）
 * @param size 最终尺寸字符串（`auto` 或规整好的 `WxH`，由 `imageSize.ts` 算出）
 */
export async function generateImage(
  prompt: string,
  model?: string,
  size?: string,
): Promise<GenerateImageOutcome> {
  const shell = bridge();
  if (!shell?.image) {
    return { ok: false, error: "图像通道不可用（需要在 Electron 里运行）" };
  }
  try {
    return await shell.image.generate({ prompt, model, size });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 把上游错误说成人话（界面直接显示这一段）。
 *
 * ⚠️ 措辞**不再长在这里**（Phase 13.1）：统一到 `shared/errors.ts` ——
 * 与文本对话那条共用同一份"原因 → 一句话"。
 *
 * 这里只保留图像通道**自己的**一点差别：`keepDetail`。
 * 出图的错误要带上上游原文（用户要拿它去查账/投诉），而文本对话那条不带
 * （协议细节糊在界面上对用户没有信息量）。
 */
export function humanImageError(raw: string): string {
  return humanFailure(raw, { keepDetail: true });
}

/** 图生图：以一张已有图为输入做编辑。 */
export async function editImage(
  source: string,
  prompt: string,
  model?: string,
  size?: string,
): Promise<
  | {
      ok: true;
      name: string;
      url: string;
      bytes: number;
      ms: number;
      model: string;
      size: string;
      inputNote?: string;
    }
  | { ok: false; error: string }
> {
  const shell = bridge();
  if (!shell?.image?.edit) {
    return { ok: false, error: "图像通道不可用（需要在 Electron 里运行）" };
  }
  try {
    return await shell.image.edit({ source, prompt, model, size });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
