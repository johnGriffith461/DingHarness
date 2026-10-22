import { ipcMain } from "electron";

import { attachToWebContents, detachFromWebContents } from "./browserHost";

/**
 * **右栏浏览器与 agent 的接线**（B-01，2026-10-22）。
 *
 * 只有一个浏览器：面板把 `<webview>` 的 webContentsId 报上来，agent 工具就操作它。
 * 之前是两套（面板一个、`browserHost` 自己开一个独立窗口），
 * 于是"用户在看这一页、模型在读那一页"。
 */
export const BROWSER_ATTACH_CHANNEL = {
  attach: "browser:attach",
  detach: "browser:detach",
} as const;

export function registerBrowserAttachIpc(): void {
  ipcMain.handle(BROWSER_ATTACH_CHANNEL.attach, (_event, id: unknown) => {
    if (typeof id !== "number") return { ok: false, error: "webContentsId 必须是数字" };
    return attachToWebContents(id);
  });
  ipcMain.handle(BROWSER_ATTACH_CHANNEL.detach, (_event, id: unknown) => {
    detachFromWebContents(typeof id === "number" ? id : undefined);
    return { ok: true };
  });
}
