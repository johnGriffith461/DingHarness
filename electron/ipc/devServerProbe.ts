/**
 * dev server 探测（**审计 P12**）。
 *
 * ## 缺陷形状
 *
 * `main.ts` 的 `shouldUseDevServer` 原来用 `fetch(DEV_SERVER, { method: "HEAD" })`，
 * 判据是 `res.ok || res.status === 404` —— **404 也算"dev server 在跑"**。
 * 后果：本机 5173 上任何一个别的服务（甚至只是返回 404 的空壳）都会让应用
 * `loadURL("http://localhost:5173")` 并注入整套 preload，得到一个白窗口，
 * 而"没有 dev server"这条真分支永远走不到。
 *
 * 现在改成真取一次页面，并要求看到 Vite 客户端脚本的标记（`/@vite/client`）——
 * 这是"这确实是本项目的 dev server"的可判据特征，而不是"端口上有人应答"。
 */

/** Vite 开发态注入的客户端脚本路径。看到它才认这是本项目的 dev server。 */
export const VITE_DEV_MARK = "/@vite/client";

/** 页面上有没有 Vite 客户端标记。 */
export function looksLikeViteDevServer(body: string): boolean {
  return typeof body === "string" && body.includes(VITE_DEV_MARK);
}

/**
 * 探一次 dev server。
 *
 * @param baseUrl dev server 地址
 * @param doFetch 取页面的实现（默认全局 `fetch`；测试可注入）
 * @returns 真的是本项目的 Vite dev server 才返回 true
 */
export async function probeViteDevServer(baseUrl: string, doFetch: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await doFetch(baseUrl, { method: "GET" });
    if (!res.ok) return false;
    const body = await res.text();
    return looksLikeViteDevServer(body);
  } catch {
    return false;
  }
}
