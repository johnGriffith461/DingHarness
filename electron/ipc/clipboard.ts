import { clipboard } from "electron";

/**
 * 剪贴板（§173）。
 *
 * ## 为什么要走主进程
 *
 * 渲染进程里 `navigator.clipboard` 在**非安全上下文**下是不让用的
 * （本机的页面走 `file:` / 自定义协议，不算安全上下文），
 * 而且它会弹出一个权限询问 —— 那对"点一下粘贴"来说太重了。
 *
 * Electron 主进程的 `clipboard` 模块没有这些问题，读写都是同步的。
 *
 * ## 边界
 *
 * 只做**纯文本**：富文本/图片进来会变成一堆看不懂的东西，
 * 而文档动作条上的「粘贴」本来就是"把一段文字放进来"。
 */

/** IPC 通道名（preload 与主进程共用，免得两边写错字符串）。 */
export const CLIPBOARD_CHANNEL = {
  read: "clipboard:read",
  write: "clipboard:write",
} as const;

/**
 * 注册剪贴板 IPC。
 *
 * @param ipc Electron 的 `ipcMain`
 */
export function registerClipboardIpc(ipc: Electron.IpcMain): void {
  /*
   * 不用写返回类型标注：`ipcMain.handle` 的监听器签名在 Electron 的类型里
   * 是按"返回值给 invoke 那边"推的，标一个 `string` 反而会与它对不上
   * （TS2322：Promise<string> 不能赋给 string）。让 inference 走。
   */
  ipc.handle(CLIPBOARD_CHANNEL.read, () => clipboard.readText() ?? "");
  ipc.handle(CLIPBOARD_CHANNEL.write, (_event, text: unknown) => {
    clipboard.writeText(String(text ?? ""));
    return true;
  });
}
