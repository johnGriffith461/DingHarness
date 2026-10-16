import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { uniqueFilePath } from "../../engine/runtime/assetName";

/**
 * 画布导出 PNG（阶段 8.6，对标原版 `data-canvas-export-host` / `data-canvas-export-scene`）。
 *
 * 实现思路：不引第三方库（`html-to-image` 那类要重新把 DOM 序列化一遍，
 * 遇到 canvas/WebGL/字体就会走样），而是直接让 Electron 把**窗口的这一块区域**截下来。
 * 好处是所见即所得 —— 屏幕上是什么样，导出的就是什么样。
 *
 * 代价要如实说明：导出的是**屏幕分辨率**（当前缩放比例下的像素），
 * 不是 1:1 的矢量重绘。所以：
 *   · `deviceScaleFactor` 参与换算，Retina/高 DPI 下不会糊；
 *   · 想让导出更清晰，先把画布缩放调大再导（这条也写进界面提示里）。
 */

export const CANVAS_EXPORT_CHANNEL = {
  exportPng: "canvas:exportPng",
  revealExports: "canvas:revealExports",
};

export type ExportRequest = {
  /** 要截取的矩形，单位是**窗口 CSS 像素**（调用方从 getBoundingClientRect 拿来）。 */
  rect: { x: number; y: number; width: number; height: number };
  /** 文件名主体（不含扩展名与时间戳）。 */
  name?: string;
};

export type ExportResult =
  | { ok: true; file: string; width: number; height: number }
  | { ok: false; error: string };

/**
 * 导出目录：放在 userData 下。
 * 用 `app.getPath("userData")` 而不是随便挑个相对目录 —— 这样打包后落在系统用户目录、
 * 开发时落在仓库的 `data/`（和快照同一个根），跟应用其它数据在一起，不会被清理脚本误删。
 */
export function exportsDir(): string {
  return path.join(app.getPath("userData"), "exports");
}

/** 过滤掉文件名里不能用的字符。 */
function safeName(input: string): string {
  return (
    input
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "画布"
  );
}

export function registerCanvasExportIpc(): void {
  ipcMain.handle(CANVAS_EXPORT_CHANNEL.exportPng, async (event, request: ExportRequest) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { ok: false, error: "找不到窗口" } satisfies ExportResult;

    const rect = {
      x: Math.max(0, Math.round(request.rect.x)),
      y: Math.max(0, Math.round(request.rect.y)),
      width: Math.max(1, Math.round(request.rect.width)),
      height: Math.max(1, Math.round(request.rect.height)),
    };

    try {
      // capturePage 收的是 CSS 像素；返回的图已是物理像素，不用自己乘 scaleFactor
      const image = await window.webContents.capturePage(rect);
      const size = image.getSize();
      if (size.width === 0 || size.height === 0) {
        return { ok: false, error: "截出来是空图（目标区域可能不在可视范围内）" } satisfies ExportResult;
      }

      const dir = exportsDir();
      /*
       * ⭐ 落盘改**异步**、名字走统一口径（2026-10-16，审计 P21）。
       *
       * 原来是 `mkdirSync` + `writeFileSync`，而时间戳只到**秒**：
       * 同一个 tick 里导两次（连点两下、或脚本连着调）后者无声盖掉前者；
       * 而同步写一张大图会把主进程的事件循环整段按住 —— 那期间模型流式吐字全停。
       */
      await fs.promises.mkdir(dir, { recursive: true });
      const file = uniqueFilePath(dir, safeName(request.name ?? "画布"), ".png");
      await fs.promises.writeFile(file, image.toPNG());
      return { ok: true, file, width: size.width, height: size.height } satisfies ExportResult;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ExportResult;
    }
  });

  ipcMain.handle(CANVAS_EXPORT_CHANNEL.revealExports, async () => {
    const dir = exportsDir();
    /* 同步 mkdir 换成异步（审计 P21）：打开目录不该按住主进程 */
    await fs.promises.mkdir(dir, { recursive: true });
    void shell.openPath(dir);
    return { ok: true, dir };
  });
}
