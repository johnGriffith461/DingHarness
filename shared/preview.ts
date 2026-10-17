/**
 * 内置预览的地址策略（V6-2m）。
 *
 * 单独放 shared 是为了能在 node 里直接单测：`electron/ipc/preview.ts` 一 import
 * 就会拉起 Electron，而"哪些地址允许预览"是一个纯函数。
 */

/**
 * 这个地址能不能在内置预览里打开。
 *
 * 只允许本机：`localhost` / `127.0.0.1` / `::1` / `*.localhost`，协议只允许 http(s)。
 * 其它地址一律拒 —— 预览窗口不带应用的 preload，但也不该变成一个任意网页浏览器。
 *
 * @param raw 用户/agent 给的地址
 * @returns 规范化后的 URL；不允许则 null
 */
export function previewableUrl(raw: unknown): URL | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost");
  return local ? url : null;
}
