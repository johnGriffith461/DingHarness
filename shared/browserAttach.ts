/**
 * **能不能把某个 webContents 交给 agent 当浏览器**（B-01，2026-10-22）。
 *
 * 纯函数：只认 `<webview>`。主窗口、独立窗口、devtools 一律不接 ——
 * 否则模型会把"用户的整个工作台"当成网页去点。
 */
export function isAttachable(type: string | undefined | null): boolean {
  return type === "webview";
}

/** 未接上时的统一话术（界面与工具共用一个说法）。 */
export const NOT_ATTACHED_NOTICE =
  "还没有接上右栏浏览器 —— 先打开右栏的「浏览器」页签（agent 操作的就是你看到的那一页）";
