import pangu from "pangu";

/**
 * 中英混排自动加空格（对标原版 `pangu.spacing()`，HANDOFF §6.5）。
 *
 * 原版就是这么做的（`REFERENCE.md` E-012）。pangu 的浏览器构建是 UMD，
 * 这里包一层：拿不到就用本地兜底规则，保证文本节点永远有合理排版，不会因为
 * 依赖形态问题整体崩掉。
 */

export const CJK = "\\u2e80-\\u2eff\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";

/** CJK 与半角字符之间的加空格规则（pangu 核心规则的精简版）。 */
function fallbackSpacing(text: string): string {
  return text
    .replace(new RegExp(`([${CJK}])([A-Za-z0-9\`~!@#$%^&*()\\-_=+\\[\\]{}\\|;:'",.<>/?\\\\])`, "g"), "$1 $2")
    .replace(new RegExp(`([A-Za-z0-9\`~!@#$%^&*()\\-_=+\\[\\]{}\\|;:'",.<>/?\\\\])([${CJK}])`, "g"), "$1 $2")
    .replace(new RegExp(`([${CJK}])([${CJK}])`, "g"), "$1$2");
}

/**
 * 给一整段文本做中英混排。
 * @param text 原文
 * @returns 加好空格的文本；pangu 不可用时走本地兜底
 */
export function spacing(text: string): string {
  if (!text) return text;
  const fn = (pangu as { spacing?: (s: string) => string }).spacing;
  if (typeof fn !== "function") return fallbackSpacing(text);
  try {
    return fn(text);
  } catch {
    return fallbackSpacing(text);
  }
}

/** 逐行做中英混排（保留用户换行与空行）。 */
export function spacingLines(text: string): string {
  return text.split("\n").map(spacing).join("\n");
}

/** 供单测直接验证兜底规则。 */
export const __fallbackSpacing = fallbackSpacing;
