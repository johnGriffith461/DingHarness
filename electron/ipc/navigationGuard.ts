/**
 * 主进程侧的外链与导航收口（**审计 P06** 的主进程那一半）。
 *
 * ## 它挡的是什么
 *
 * 整改前 `main.ts` 里只有一句 `setWindowOpenHandler(() => { void shell.openExternal(url); ... })`：
 * **不认协议** —— 页面里一个 `file:///…` 或 `javascript:` 链接、
 * 或任意被注入的 `window.open(...)`，都会被原样递给系统去打开；
 * 而 `will-navigate` 一次都没接：页面自己 `location.href = …` 就能把整个应用窗口
 * 导航去任意站点，连 preload 都在那条页面上继续挂着。
 *
 * 两件事都在这一份里收口（纯函数，无 electron 依赖，`src/electronGuards.test.ts` 直接测）：
 *   · `isAllowedExternalUrl` —— 交给系统浏览器的协议白名单（只放 http / https / mailto）；
 *   · `isAllowedNavigation` —— 应用自身文档之外的导航一律拦；
 *   · `withFrameAncestors` —— meta CSP 管不了 `frame-ancestors`（那条只能走响应头），
 *     所以由 `webRequest.onHeadersReceived` 补一条同样的响应头。
 */

/** 允许交给系统浏览器打开的协议。其余（`file:` / `javascript:` / `data:` …）一律拒。 */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * 能不能把这条 URL 交给 `shell.openExternal`。
 *
 * @param raw 页面给的 URL（不可信）
 * @returns 只有 http / https / mailto 且能解析成 URL 才为 true
 */
export function isAllowedExternalUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return EXTERNAL_PROTOCOLS.has(parsed.protocol);
}

/** 导航白名单的两条腿：应用自己的产物文档 + 开发态 dev server。 */
export type NavigationAllowlist = {
  /** 打包/本地产物文档（`file://…/dist/index.html`）。 */
  fileUrl: string;
  /** 开发态 dev server 地址（`http://localhost:5173`）。 */
  devServerUrl: string;
};

/** 比较两个 `file:` URL 是不是同一份文档（Windows 下盘符大小写不敏感）。 */
function sameFileDocument(a: URL, b: URL): boolean {
  if (b.protocol !== "file:") return false;
  const norm = (s: string) => decodeURIComponent(s).replace(/\/+$/, "").toLowerCase();
  return norm(a.pathname) === norm(b.pathname);
}

/**
 * 这条导航该不该放行。
 *
 * 只放行两处：应用自己的产物文档，以及开发态 dev server 的**同源**页面
 * （Vite 的 HMR / 路由需要）。其余一律拦 —— 拦在 `will-navigate` 里而不是只拦新窗口，
 * 是因为页面自己 `location.href = …` 根本不经过 `setWindowOpenHandler`。
 *
 * @param raw 目标 URL（不可信）
 * @param allowed 白名单两处
 * @returns 放行 true；拦下 false
 */
export function isAllowedNavigation(raw: unknown, allowed: NavigationAllowlist): boolean {
  if (typeof raw !== "string") return false;
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return false;
  }
  if (target.protocol === "file:") {
    try {
      return sameFileDocument(target, new URL(allowed.fileUrl));
    } catch {
      return false;
    }
  }
  try {
    return target.origin === new URL(allowed.devServerUrl).origin;
  } catch {
    return false;
  }
}

/**
 * 给响应头补一条 `Content-Security-Policy: frame-ancestors 'none'`。
 *
 * 为什么必须走响应头：`frame-ancestors` 在 `<meta http-equiv="Content-Security-Policy">` 里
 * **不生效**（规范明确把它排除在 meta 之外）—— 应用文档当前那条 CSP 就是 meta 形式，
 * 所以"禁止被别人 iframe 嵌套"这一条只能由 `webRequest.onHeadersReceived` 补。
 *
 * 已有 CSP 响应头时**追加**而不是替换（多来源的 CSP 是取交集，替换会静默放宽别人写的策略）。
 *
 * @param headers 主进程收到的响应头（可能没有）
 * @returns 补好 frame-ancestors 的响应头
 */
export function withFrameAncestors(headers?: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = { ...(headers ?? {}) };
  const existingKey = Object.keys(out).find((k) => k.toLowerCase() === "content-security-policy");
  const existing = existingKey ? out[existingKey]! : [];
  if (existingKey) delete out[existingKey];
  /* 已经写过的就不重复加（幂等） */
  out["Content-Security-Policy"] = existing.includes("frame-ancestors 'none'")
    ? existing
    : [...existing, "frame-ancestors 'none'"];
  return out;
}
