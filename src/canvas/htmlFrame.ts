/**
 * HTML 节点的沙箱与尺寸协议（阶段 9.1，对标原版 `data-canvas-html-*`）。
 *
 * ## 原版怎么做的、我们为什么不一样
 * 原版用一个 iframe 渲染用户 HTML，sandbox 是：
 * ```
 * allow-scripts allow-same-origin allow-downloads allow-popups allow-forms
 * allow-top-navigation-by-user-activation allow-top-navigation-to-custom-protocols
 * ```
 * 其中 **`allow-scripts` + `allow-same-origin` 同时出现是经典的"沙箱自毁"组合**：
 * 被框内容与宿主同源，于是它能自己把自己的 sandbox 属性摘掉，
 * 进而摸到宿主的 origin、cookie 和 DOM —— 等于没有隔离。
 *
 * 我们只用 **`allow-scripts`**（不给 `allow-same-origin`）：被框内容拿到一个
 * **唯一的不透明源**，脚本照跑，但碰不到宿主。代价是宿主也读不到 iframe 内部
 * （这正是隔离的意义），所以高度必须由 iframe **主动 postMessage 上报**。
 *
 * ## 消息为什么必须校验来源
 * 不给 `allow-same-origin` 之后，我们与 iframe 之间只剩 `postMessage` 一条路。
 * 页面上任何其它 frame（比如用户 HTML 里自己嵌的 iframe、或者别的扩展注入的）
 * 都能往我们这儿发消息。所以：
 *   · 每条消息带一个**随机 channelId**，不匹配就丢；
 *   · 再核对 `event.source === iframe.contentWindow`，双保险。
 * 只看 `event.origin` 是不够的 —— 不透明源的 origin 序列化成 `"null"`，没法区分彼此。
 */

/** iframe 上报消息的标记，避免和页面上其它消息撞。 */
export const HTML_FRAME_CHANNEL = "dsh-html-node";

/** 上报的两种消息。 */
export type HtmlFrameMessage =
  | { channel: typeof HTML_FRAME_CHANNEL; channelId: string; kind: "height"; height: number }
  | { channel: typeof HTML_FRAME_CHANNEL; channelId: string; kind: "error"; message: string };

/**
 * ## 一段走错路的记录：不要给 iframe 套"输入转发层"
 *
 * 我曾以为跨进程 iframe 在 `transform: scale()` 的视口里收不到正确坐标，
 * 于是给 iframe 加 `pointer-events: none`、上面盖一层 `.nv-html-hit`，
 * 自己在主文档里算框内坐标再 postMessage 进去。
 *
 * **那个判断是错的，代理层已经撤掉**。错在把两个坐标系混着比：
 * iframe 被 `scale(0.77)` 缩小后，它的**内部 CSS 像素空间比屏幕空间大**
 * （实测框宽 324 屏幕像素 = 418 内部像素），所以"屏幕差值 × 1/zoom = 内部坐标"
 * 本来就是正常的换算，不是浏览器送错。
 *
 * 把三个坐标系老实量一遍就清楚了（`.verify\diag-html-coords.mjs`）：
 *
 * | 量什么 | 值 |
 * |---|---|
 * | 按钮的**框内**中心（在 iframe 里 `getBoundingClientRect`） | `(89, 99)` |
 * | 浏览器实际送进框内的 `pointerdown` | `(88, 99)` ✅ **完全正确** |
 *
 * 真正出错的是**测量工具**：Playwright 对缩放后的跨进程 iframe 里元素
 * 调 `boundingBox()` 返回的屏幕坐标是错的（y 偏了 42px），拿它去点自然点空。
 * 在框内直接 `el.click()` 一直能跑，也印证了处理器与 CSP 都没问题。
 *
 * 教训写在验收脚本里：**要拿框内元素的屏幕坐标，就用"框内 rect × zoom + iframe 屏幕原点"
 * 自己算，别信跨进程 iframe 的 `boundingBox()`**。
 */


/** 画布上允许的 iframe 高度范围（防止用户 HTML 报一个 10 万像素把画布撑爆）。 */
export const MIN_FRAME_HEIGHT = 80;
export const MAX_FRAME_HEIGHT = 2400;

/** 生成一个短随机 channelId（用 crypto，别用 Math.random）。 */
export function makeChannelId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 组装 CSP。
 *
 * 默认**断网**：用户 HTML 里的 `<script src="https://…">` 不会被执行、
 * `fetch` 也出不去。理由是这个节点是"本地渲染一段 HTML"，不是"跑一个网页"；
 * 默认放行外链等于让一段粘贴进来的 HTML 悄悄往外发数据。
 *
 * @param allowNetwork 用户显式打开时才放行 https 外链
 * @returns CSP 字符串
 */
export function buildCsp(allowNetwork: boolean): string {
  if (allowNetwork) {
    return [
      "default-src 'none'",
      // 允许 https 外链脚本/样式，方便用 CDN 的 HTML 片段
      "script-src 'unsafe-inline' 'unsafe-eval' https:",
      "style-src 'unsafe-inline' https:",
      "img-src data: blob: https:",
      "font-src data: https:",
      "connect-src https:",
      "media-src data: blob: https:",
    ].join("; ");
  }
  return [
    "default-src 'none'",
    // 只跑内联脚本（用户自己写的那段），外链脚本一律不执行
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    // 图片允许内联与 https（看图比联网危险小得多，且粘贴的 HTML 常带图床链接）
    "img-src data: blob: https:",
    "font-src data:",
    // 断掉 fetch / XHR / WebSocket / sendBeacon
    "connect-src 'none'",
  ].join("; ");
}

/**
 * 把用户的 HTML 包成一个可渲染的 srcdoc。
 *
 * @param html 用户 HTML（可以是碎片，也可以是整页）
 * @param channelId 上报用的 channel
 * @param allowNetwork 是否放行外链
 * @returns 可直接塞进 `iframe.srcdoc` 的完整文档
 */
export function buildSrcdoc(html: string, channelId: string, allowNetwork = false): string {
  const csp = buildCsp(allowNetwork);

  /**
   * 注入的上报脚本。
   *
   * ⚠️ 这件事比看上去难：**文档刚插入时还没完成布局**，这时读到的
   * `scrollHeight` 是缩水的（实测把需要 ~104px 的内容报成 73px，
   * 结果按钮被 iframe 裁掉、用户点不到）。所以不能只报一次：
   *   · 多档延时各报一次（0 / 60 / 200 / 600 / 1200ms），覆盖字体与图片撑开的时间；
   *   · `ResizeObserver` 盯内容尺寸变化；
   *   · `MutationObserver` 盯 DOM 变化（脚本往页面里插东西时 RO 不一定触发）。
   * 多报几次的代价可以忽略（每条就是一次 postMessage），报小了才是真问题。
   */
  const reporter = `
<script>
(function () {
  var CH = ${JSON.stringify(HTML_FRAME_CHANNEL)};
  var ID = ${JSON.stringify(channelId)};
  var MIN = ${MIN_FRAME_HEIGHT};
  var MAX = ${MAX_FRAME_HEIGHT};
  var last = -1;
  function measure() {
    try {
      var doc = document.documentElement;
      var body = document.body;
      var h = Math.max(
        doc ? doc.scrollHeight : 0,
        doc ? doc.offsetHeight : 0,
        body ? body.scrollHeight : 0,
        body ? body.offsetHeight : 0
      );
      return Math.max(MIN, Math.min(MAX, Math.ceil(h)));
    } catch (e) { return MIN; }
  }
  function report(force) {
    var h = measure();
    // 值没变就不重复发（省点消息），除非是强制上报
    if (!force && h === last) return;
    last = h;
    try {
      parent.postMessage({ channel: CH, channelId: ID, kind: "height", height: h }, "*");
    } catch (e) { /* 发不出去就算了，宿主会用默认高度 */ }
  }
  window.addEventListener("error", function (e) {
    try {
      parent.postMessage({ channel: CH, channelId: ID, kind: "error", message: String(e.message || e) }, "*");
    } catch (_) {}
  });
  [0, 60, 200, 600, 1200, 2400].forEach(function (t) { setTimeout(function () { report(t >= 600); }, t); });
  window.addEventListener("load", function () { report(true); });
  if (typeof ResizeObserver !== "undefined") {
    try {
      var ro = new ResizeObserver(function () { report(false); });
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    } catch (_) {}
  }
  if (typeof MutationObserver !== "undefined") {
    try {
      var mo = new MutationObserver(function () { report(false); });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    } catch (_) {}
  }
})();
</script>`;

  // 用户给的是整页：只在 <head> 里插 CSP，在 </body> 前插上报脚本
  const headInjection = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const hasHead = /<head[\s>]/i.test(html);
  const hasBodyClose = /<\/body\s*>/i.test(html);

  if (hasHead || hasBodyClose || /<html[\s>]/i.test(html)) {
    let out = html;
    if (hasHead) {
      out = out.replace(/<head([^>]*)>/i, `<head$1>${headInjection}`);
    } else {
      out = out.replace(/<html([^>]*)>/i, `<html$1><head>${headInjection}</head>`);
    }
    if (hasBodyClose) {
      out = out.replace(/<\/body\s*>/i, `${reporter}</body>`);
    } else {
      out = `${out}${reporter}`;
    }
    return out;
  }

  // 用户给的是一段碎片：兜一个完整文档，碎片塞进 body
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${headInjection}
<style>html,body{margin:0;padding:12px;background:#fff;color:#111;font:13px/1.6 system-ui,sans-serif}</style>
</head>
<body>
${html}
${reporter}
</body>
</html>`;
}

/**
 * 校验一条消息是不是我们这个 iframe 发来的。
 *
 * @param data `message` 事件的 data
 * @param channelId 本节点分配的 channel
 * @param sourceIsFrame `event.source === iframe.contentWindow`
 * @returns 通过校验的消息；否则 null（**静默丢弃**，不要往界面报错——
 *          页面上无关的 frame 发消息是正常现象）
 */
export function parseFrameMessage(
  data: unknown,
  channelId: string,
  sourceIsFrame: boolean,
): HtmlFrameMessage | null {
  if (!sourceIsFrame) return null;
  if (!data || typeof data !== "object") return null;
  const msg = data as Record<string, unknown>;
  if (msg.channel !== HTML_FRAME_CHANNEL) return null;
  if (msg.channelId !== channelId) return null;
  if (msg.kind === "height") {
    const h = Number(msg.height);
    if (!Number.isFinite(h)) return null;
    return {
      channel: HTML_FRAME_CHANNEL,
      channelId,
      kind: "height",
      height: Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, Math.round(h))),
    };
  }
  if (msg.kind === "error") {
    return { channel: HTML_FRAME_CHANNEL, channelId, kind: "error", message: String(msg.message ?? "").slice(0, 300) };
  }
  return null;
}

/**
 * 把 HTML 里"会执行代码 / 会往外连"的地方统计出来，给界面一句"这段 HTML 会做什么"的提示。
 *
 * 不是安全边界（边界在 sandbox 与 CSP 上），只是让用户知道**自己要预览的东西会执行脚本** ——
 * 粘贴一段不知道哪来的 HTML 时，这句话比任何免责声明都有用。
 *
 * ⚠️ **必须把内联事件处理器也算进来**：只数 `<script>` 标签会漏掉
 * `onclick="..."` / `onerror="..."` 这类写法 —— 而它们同样会执行代码。
 * 早期实现只数标签，于是示例里明明有 `onclick`，界面却显示"纯静态内容"，
 * 这个提示一旦失真就完全白做了。
 *
 * @param html 用户 HTML
 * @returns `scripts` = 会执行代码的位置数（脚本标签 + 内联事件处理器）；
 *          `externalRefs` = https 外链引用数
 */
export function describeHtml(html: string): { scripts: number; externalRefs: number } {
  const scriptTags = (html.match(/<script[\s>]/gi) ?? []).length;
  // on*="…" / on*='…' / on*=裸值 —— 三种写法都要数
  const inlineHandlers = (html.match(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi) ?? []).length;
  const externalRefs = (html.match(/\b(?:src|href)\s*=\s*["']https?:\/\//gi) ?? []).length;
  return { scripts: scriptTags + inlineHandlers, externalRefs };
}
