import lockup from "../assets/logo-lockup.svg?raw";

/**
 * 品牌标识（二合一：盯 + Dingwork）—— 2026-10-14 换身份时落的第一处。
 *
 * ## 为什么走"整份注入"而不是把路径抄进来
 * 这份 SVG 里 **「Dingwork」那几个字的路径在外面套了一层 `<g transform>`**
 * （提案 §06 专门点了这条坑：手抄路径、漏掉外层 transform，肉眼就只剩一个"盯"）。
 * 整份注入天然不会丢结构，也不需要把 16KB 的路径数据塞进源码。
 *
 * ## 为什么在这里改填充色
 * 资产里写的是设计方的**日间原色**（`#1b1a14` 墨 / `#9a2f1c` 朱红），日间它们恰好等于
 * 本主题的 `--fg` / `--accent` —— 但夜间就对不上了。所以注入时把这四处映射到令牌：
 *   · 墨 → `currentColor`（外层 `.wb-brand` 给了 `color: var(--fg)`）
 *   · 朱红 → `style="fill:var(--accent)"`
 * 于是**一份资产同时服务日夜**，不用两套图（这也正是提案 §06 的做法）。
 * ⚠️ 朱红那两处不能写成 `fill="var(--accent)"`（表现属性里 `var()` 的支持不可靠），
 * 落到 `style` 里才是稳的。资产本身保持设计方的原样，方便他日后再导出替换。
 */
const svg = lockup
  .replace(/fill="#1b1a14"/gi, 'fill="currentColor"')
  .replace(/fill="#9a2f1c"/gi, 'style="fill:var(--accent)"');

export function BrandMark() {
  return <span className="wb-brand" aria-label="Dingwork" role="img" dangerouslySetInnerHTML={{ __html: svg }} />;
}
