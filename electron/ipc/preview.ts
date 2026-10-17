import { BrowserWindow, ipcMain, shell } from "electron";

import { previewableUrl } from "../../shared/preview";

/**
 * 内置浏览器预览（V6-2m）。
 *
 * ## 它解决什么
 *
 * agent 改完一个本地页面（dev server / 静态文件），用户要**当场看见**。
 * 以前只能"用系统默认程序打开"—— 那就跑出了应用，预览与对话不在一个上下文里。
 *
 * ## 为什么是独立窗口 + 持久分区
 *
 * - **独立窗口**：不用 WebContentsView 去追主窗口的布局坐标（那要求渲染层汇报
 *   DOM 矩形、随滚动/缩放漂移，是个长期维护点）；
 * - **`persist:preview` 分区**：登录态（cookie/localStorage）跨次保留 ——
 *   "真实登录态预览"要的就是这个；同时与主应用的会话隔离（预览页拿不到应用凭据）。
 *
 * ## 安全边界（不装）
 *
 * - **只允许本机地址**：`localhost` / `127.0.0.1` / `::1` / `*.localhost`；
 *   其它地址一律拒 —— 预览窗口不带我们的 preload，但仍不该变成一个任意浏览器；
 * - `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；
 * - 新窗口一律 deny（要开新页就在同一个窗口里导航，仍受本机地址限制）。
 */

export const PREVIEW_CHANNEL = {
  open: "preview:open",
  close: "preview:close",
} as const;

/** 已经打开的预览窗口（最多一个；重复 open 复用并导航）。 */
let previewWin: BrowserWindow | null = null;

export function registerPreviewIpc(): void {
  ipcMain.handle(PREVIEW_CHANNEL.open, async (_event, raw: unknown) => {
    const url = previewableUrl(raw);
    if (!url) {
      return { ok: false, error: "只允许本机地址（localhost / 127.0.0.1 / ::1 / *.localhost）的 http(s) 页面" };
    }
    if (previewWin && !previewWin.isDestroyed()) {
      await previewWin.loadURL(url.toString());
      previewWin.show();
      previewWin.focus();
      return { ok: true, reused: true };
    }
    const win = new BrowserWindow({
      width: 1024,
      height: 720,
      title: `预览 · ${url.host}`,
      autoHideMenuBar: true,
      webPreferences: {
        partition: "persist:preview",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    previewWin = win;
    win.on("closed", () => {
      if (previewWin === win) previewWin = null;
    });
    /* 新窗口一律拒；外链交给系统浏览器（并明确不是"预览"） */
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (previewableUrl(target)) void win.loadURL(target);
      else void shell.openExternal(target);
      return { action: "deny" };
    });
    /* 导航只许留在本机地址（防止预览页把我们变成任意浏览器） */
    win.webContents.on("will-navigate", (event, target) => {
      if (!previewableUrl(target)) {
        event.preventDefault();
        void shell.openExternal(target);
      }
    });
    await win.loadURL(url.toString());
    return { ok: true, reused: false };
  });

  ipcMain.handle(PREVIEW_CHANNEL.close, () => {
    if (previewWin && !previewWin.isDestroyed()) previewWin.close();
    previewWin = null;
    return { ok: true };
  });
}
