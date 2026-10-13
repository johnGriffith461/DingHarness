import type { ShellBridge } from "@shared/ipc";

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

/** 把上游错误说成人话（界面直接显示这一段）。 */
export function humanImageError(raw: string): string {
  if (/欠费|Arrearage|overdue|good standing/i.test(raw)) return `账号欠费，出不了图：${raw}`;
  if (/429|rate|quota|额度/i.test(raw)) return `被限流或额度用完了：${raw}`;
  if (/content|policy|safety|审核/i.test(raw)) return `内容审核没通过：${raw}`;
  if (/timeout|abort/i.test(raw)) return `超时了（生成可能还在排队，稍后重试）：${raw}`;
  /**
   * 这一条是实测踩出来的：输入图尺寸不合规时，上游不报"输入不合规"，
   * 而是回一个**毫无指向性**的 `502 Upstream service temporarily unavailable`。
   * 照原文显示会让人一直以为是上游挂了，所以这里点明最可能的原因。
   */
  if (/502|503|unavailable/i.test(raw)) {
    return `上游暂时不可用：${raw}（若反复出现，多半是输入图尺寸不合规 —— 应用会自动规整后再发，可稍后重试）`;
  }
  return raw;
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
