/**
 * **浏览器地址策略**（B-05，2026-10-22）—— 唯一一份实现。
 *
 * 之前地址校验散在四处：`previewableUrl`（预览/本机）、`browserOpen`（外网需放行）、
 * `web_fetch` 的 `isBlockedUrl`（禁私网）、`modelGate`（零出网闸）。四份规则各说各话，
 * 迟早有一处漏掉。这里把"这个地址能不能进浏览器"收成一条**纯函数**，
 * 导航、点击跳转、重定向、新标签都过它。
 *
 * 拒绝的四类（对应方案 §2 第 7 条）：
 * - 非 http(s)：`file:` / `data:` / `javascript:` / `about:`（除 `about:blank`）；
 * - 私网与回环：`127.0.0.1` / `10.x` / `172.16-31.x` / `192.168.x` / `::1` / `*.local`
 *   —— ⚠️ **本机页面（本地测试站）也要显式放行**，这是"不给模型自己开本地服务"的边界；
 * - 带凭据的 URL（`user:pass@`）：容易把密码写进日志；
 * - 解析不了的东西。
 */

/** 私网/回环判定（只看 hostname）。 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
  }
  /* IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10 */
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;
  return false;
}

/**
 * 这个地址为什么不能进浏览器（`null` = 可以）。
 *
 * @param url 原始地址
 * @param opts.allowLocal 是否允许本机地址（本地测试站要显式打开这一格）
 */
export function blockedReason(url: string, opts: { allowLocal?: boolean } = {}): string | null {
  const text = String(url ?? "").trim();
  if (!text) return "地址是空的";
  if (text === "about:blank") return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "这个地址解析不了（检查一下写法）";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `只支持 http(s) 地址（收到的是 ${parsed.protocol}）`;
  }
  if (parsed.username || parsed.password) {
    return "地址里带着账号密码 —— 不要这样用（会进日志）；改成在页面里登录";
  }
  if (!opts.allowLocal && isPrivateHost(parsed.hostname)) {
    return `本机/私网地址默认不放行（${parsed.hostname}）—— 需要时在设置里显式允许本机页面`;
  }
  return null;
}
