import lockup from "../assets/logo-lockup.svg?raw";

/**
 * 品牌标识（二合一：盯 + Ding Harness）—— 2026-10-14 换身份时落的第一处。
 *
 * ## 为什么走"整份注入"
 * 资产里前半段是「盯」的两条路径，后半段是字标。字标用 `<text>`（Georgia 系衬线栈）：
 * 我们手上**没有「Harness」的字形路径**（原资产只有「Dingwork」的字形），
 * 硬造一套路径既不准确也不好维护。代价是字标依赖本机字体，所以给了一串回退
 * （Georgia → Times New Roman → 宋体 → serif），三端都能落到一个衬线体上。
 *
 * ⚠️ **2026-10-18（D02）**：原资产渲染出来是 **Dingwork**（审计说得对，这里早期的注释
 * 却写着"Ding Harness 的路径"—— 注释和资产对不上）。现在换成 `Ding Harness`，
 * 并由 `src/brandAsset.test.ts` 钉住"资产里不许再出现 Dingwork"。
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
  return <span className="wb-brand" aria-label="Ding Harness" role="img" dangerouslySetInnerHTML={{ __html: svg }} />;
}
