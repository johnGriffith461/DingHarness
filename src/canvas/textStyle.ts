import type { CSSProperties } from "react";

/**
 * 文字排版（阶段 8.5，对标原版 `aiCreation_canvas_textAction_*`）。
 *
 * 原版在这一块有 7 个动作：字距 / 行高 / 边框宽度 / 自动高度 / 自动宽度 / 固定尺寸 / 布局。
 * 口径是从它扩展里捞出来的**真实取值**（`.verify\dig-textstyle.mjs`），不是猜的：
 *   · `letterSpacing` 用 **em**（实测有 `-0.2em`，说明允许负值 —— 中文大字标题要收紧）
 *   · `lineHeight` 用**倍数**（实测 1.5 / 1.7），不是 px
 *   · `borderWidth` 用 px（实测 0.5px 这种小数）
 *   · 字号范围实测 9~18，字重 400 / 500 / 600
 *
 * 值域与步长集中在这里：滑块、限幅、CSS 三处读同一份，免得界面能给到 30
 * 而样式里被夹到 18，用户看到"拖到底了但没变化"。
 */

export type TextAlign = "left" | "center" | "right";
export type TextWeight = 400 | 500 | 600;
/** 尺寸模式：自动宽高 / 固定尺寸（对标 autoWidth + autoHeight / fixedSize）。 */
export type SizeMode = "auto" | "fixed" | "mixed";

/** 一个节点的文字排版属性；全部可选，缺省用 `DEFAULT_TEXT_STYLE`。 */
export type TextStyle = {
  align?: TextAlign;
  /** 字距，单位 em（可负）。 */
  letterSpacing?: number;
  /** 行高倍数。 */
  lineHeight?: number;
  /** 字号，px。 */
  fontSize?: number;
  fontWeight?: TextWeight;
  /** 边框宽度，px（画出一圈外框，方便做"文字块"的边界感）。 */
  borderWidth?: number;
  /** 宽度随内容自适应。 */
  autoWidth?: boolean;
  /** 高度随内容自适应。 */
  autoHeight?: boolean;
};

export const DEFAULT_TEXT_STYLE: Required<TextStyle> = {
  align: "left",
  letterSpacing: 0,
  lineHeight: 1.6,
  fontSize: 13,
  fontWeight: 400,
  borderWidth: 0,
  autoWidth: false,
  autoHeight: false,
};

/** 每个数值字段的值域与步长（界面与限幅共用这一份）。 */
export const TEXT_STYLE_LIMITS = {
  letterSpacing: { min: -0.06, max: 0.3, step: 0.005 },
  lineHeight: { min: 0.9, max: 2.4, step: 0.05 },
  fontSize: { min: 9, max: 18, step: 0.5 },
  borderWidth: { min: 0, max: 8, step: 0.5 },
} as const;

export type NumericTextKey = keyof typeof TEXT_STYLE_LIMITS;

/**
 * 把数值夹到该字段的合法区间。
 *
 * 三种坏值要分开对待：
 *   · `NaN` —— 没有任何信息，退回该字段的默认值；
 *   · `±Infinity` —— **有方向**的信息（用户表达了"极大/极小"），夹到对应边界而不是丢回默认；
 *   · 普通越界值 —— 夹到最近的边界。
 * 早期实现把 Infinity 也当 NaN 处理，于是「拖到最大」会被悄悄重置成默认值。
 */
export function clampTextValue(key: NumericTextKey, value: number): number {
  const { min, max } = TEXT_STYLE_LIMITS[key];
  if (Number.isNaN(value)) return DEFAULT_TEXT_STYLE[key];
  if (value === Number.POSITIVE_INFINITY) return max;
  if (value === Number.NEGATIVE_INFINITY) return min;
  if (!Number.isFinite(value)) return DEFAULT_TEXT_STYLE[key];
  return Math.min(max, Math.max(min, value));
}

/**
 * 补全缺省值并把数值夹进值域。
 * 落盘的历史数据可能缺字段或带着越界值，读出来一律过一遍这里。
 */
export function normalizeTextStyle(style: TextStyle | undefined): Required<TextStyle> {
  const merged = { ...DEFAULT_TEXT_STYLE, ...(style ?? {}) };
  return {
    ...merged,
    letterSpacing: clampTextValue("letterSpacing", merged.letterSpacing),
    lineHeight: clampTextValue("lineHeight", merged.lineHeight),
    fontSize: clampTextValue("fontSize", merged.fontSize),
    borderWidth: clampTextValue("borderWidth", merged.borderWidth),
    autoWidth: Boolean(merged.autoWidth),
    autoHeight: Boolean(merged.autoHeight),
  };
}

/** 由当前样式判断尺寸模式（两个都自动 = auto，都不自动 = fixed，一开一关 = mixed）。 */
export function sizeModeOf(style: TextStyle | undefined): SizeMode {
  const s = normalizeTextStyle(style);
  if (s.autoWidth && s.autoHeight) return "auto";
  if (!s.autoWidth && !s.autoHeight) return "fixed";
  return "mixed";
}

/**
 * 切到某个尺寸模式。
 *
 * 「固定尺寸」是**同时**把两个自动关掉 —— 原版把它做成一个独立动作
 * （`textAction_fixedSize`），不是再开第三个开关。
 */
export function applySizeMode(style: TextStyle | undefined, mode: SizeMode): TextStyle {
  const s = normalizeTextStyle(style);
  if (mode === "auto") return { ...s, autoWidth: true, autoHeight: true };
  if (mode === "fixed") return { ...s, autoWidth: false, autoHeight: false };
  return s;
}

/**
 * 拼成 CSS。
 *
 * @param style 文字排版属性
 * @param borderColor 边框颜色（边框宽度为 0 时不产出边框）
 * @returns 可直接铺到文字块上的样式
 */
export function textStyleToCss(style: TextStyle | undefined, borderColor = "rgba(148,163,184,0.5)"): CSSProperties {
  const s = normalizeTextStyle(style);
  const css: CSSProperties = {
    textAlign: s.align,
    letterSpacing: `${s.letterSpacing}em`,
    lineHeight: s.lineHeight,
    fontSize: `${s.fontSize}px`,
    fontWeight: s.fontWeight,
  };
  if (s.borderWidth > 0) {
    css.border = `${s.borderWidth}px solid ${borderColor}`;
    css.borderRadius = 6;
    css.padding = "8px 10px";
  }
  // 自动宽高：交给内容撑开（配合节点侧不写死尺寸，见 MarkdownNode 的用法）
  css.width = s.autoWidth ? "max-content" : "100%";
  css.height = s.autoHeight ? "auto" : undefined;
  return css;
}

/** 支持文字排版的节点类型（有文字内容才有排版可言）。 */
export function supportsTextStyle(kind: string | undefined): boolean {
  return kind === "markdown" || kind === "rect" || kind === "ellipse" || kind === "frame";
}

/** 排版是否偏离默认（界面据此显示"已改动"小点）。 */
export function isTextStyleDirty(style: TextStyle | undefined): boolean {
  const s = normalizeTextStyle(style);
  return (Object.keys(DEFAULT_TEXT_STYLE) as Array<keyof Required<TextStyle>>).some(
    (k) => s[k] !== DEFAULT_TEXT_STYLE[k],
  );
}
