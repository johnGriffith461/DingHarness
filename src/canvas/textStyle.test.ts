import { describe, expect, it } from "vitest";
import {
  applySizeMode,
  clampTextValue,
  DEFAULT_TEXT_STYLE,
  isTextStyleDirty,
  normalizeTextStyle,
  sizeModeOf,
  supportsTextStyle,
  TEXT_STYLE_LIMITS,
  textStyleToCss,
} from "./textStyle";

describe("clampTextValue", () => {
  it("夹到区间内（阈值写死：9–18 是设计定的，不是从被测模块自己读的）", () => {
    /*
     * ⚠️ 2026-10-16（审计 G53.t）：原来期望值取自 `TEXT_STYLE_LIMITS.fontSize.max/min` ——
     * **被测模块自己的常量**。常量被改（比如上限改成 200）这条照样绿，
     * 而"字号能到 200px"显然不是设计意图。现在把区间**写死**在这里。
     */
    expect(clampTextValue("fontSize", 100)).toBe(18);
    expect(clampTextValue("fontSize", 1)).toBe(9);
    expect(clampTextValue("fontSize", 14)).toBe(14);
    expect(TEXT_STYLE_LIMITS.fontSize, "字号区间被改了（要同时改这里与设计稿）").toEqual({ min: 9, max: 18, step: 0.5 });
  });

  it("字距允许负值（中文大字标题要收紧）", () => {
    expect(clampTextValue("letterSpacing", -0.03)).toBe(-0.03);
    expect(clampTextValue("letterSpacing", -5)).toBe(-0.06);
  });

  it("NaN / Inf 退回默认值，不产出 NaN 的 CSS", () => {
    expect(clampTextValue("lineHeight", Number.NaN)).toBe(1.6);
    expect(clampTextValue("lineHeight", Number.POSITIVE_INFINITY)).toBe(2.4);
  });
});

describe("normalizeTextStyle", () => {
  it("空值补默认（默认值逐字写死）", () => {
    expect(normalizeTextStyle(undefined)).toEqual({
      align: "left",
      letterSpacing: 0,
      lineHeight: 1.6,
      fontSize: 13,
      fontWeight: 400,
      borderWidth: 0,
      autoWidth: false,
      autoHeight: false,
    });
  });

  it("缺失字段逐个补、越界字段逐个夹", () => {
    const out = normalizeTextStyle({ fontSize: 999, align: "center" });
    expect(out.fontSize).toBe(18);
    expect(out.align).toBe("center");
    expect(out.lineHeight).toBe(1.6);
  });

  it("布尔字段被强转（历史数据里可能是 0/1）", () => {
    const out = normalizeTextStyle({ autoWidth: 1 as unknown as boolean });
    expect(out.autoWidth).toBe(true);
  });
});

describe("sizeModeOf / applySizeMode", () => {
  it("两个都自动 = auto；都不自动 = fixed；一开一关 = mixed", () => {
    expect(sizeModeOf({ autoWidth: true, autoHeight: true })).toBe("auto");
    expect(sizeModeOf({})).toBe("fixed");
    expect(sizeModeOf({ autoWidth: true })).toBe("mixed");
  });

  it("切 auto 会把两个都打开", () => {
    expect(applySizeMode({}, "auto")).toMatchObject({ autoWidth: true, autoHeight: true });
  });

  it("切 fixed 会把两个都关掉（原版把它做成一个独立动作，不是第三个开关）", () => {
    const out = applySizeMode({ autoWidth: true, autoHeight: true }, "fixed");
    expect(out).toMatchObject({ autoWidth: false, autoHeight: false });
  });

  it("切 mixed 不动（它不是用户能点到的档位，只是内部状态）", () => {
    const src = { autoWidth: true };
    expect(applySizeMode(src, "mixed")).toMatchObject({ autoWidth: true });
  });

  it("切模式不丢其它属性", () => {
    const out = applySizeMode({ fontSize: 16, align: "center" }, "auto");
    expect(out.fontSize).toBe(16);
    expect(out.align).toBe("center");
  });
});

describe("textStyleToCss", () => {
  it("默认值长什么样", () => {
    const css = textStyleToCss(undefined);
    expect(css).toMatchObject({
      textAlign: "left",
      letterSpacing: "0em",
      lineHeight: 1.6,
      fontSize: "13px",
      fontWeight: 400,
    });
    // 边框宽度为 0 时不该产出 border（否则会多一圈看不见却占位的框）
    expect(css.border).toBeUndefined();
  });

  it("有边框宽度才产出 border", () => {
    expect(textStyleToCss({ borderWidth: 2 }).border).toContain("2px solid");
  });

  it("自动宽高影响 width", () => {
    expect(textStyleToCss({ autoWidth: true }).width).toBe("max-content");
    expect(textStyleToCss({}).width).toBe("100%");
  });

  it("越界值先被夹过再进 CSS（不会产出 999px 这种）", () => {
    expect(textStyleToCss({ fontSize: 999 }).fontSize).toBe(`${TEXT_STYLE_LIMITS.fontSize.max}px`);
  });
});

describe("supportsTextStyle", () => {
  it("有文字内容的类型才支持", () => {
    expect(supportsTextStyle("markdown")).toBe(true);
    expect(supportsTextStyle("rect")).toBe(true);
    expect(supportsTextStyle("frame")).toBe(true);
  });

  it("图片 / 白板没有排版可言", () => {
    expect(supportsTextStyle("image")).toBe(false);
    expect(supportsTextStyle("whiteboard")).toBe(false);
    expect(supportsTextStyle(undefined)).toBe(false);
  });
});

describe("isTextStyleDirty", () => {
  it("默认样式不算改动", () => {
    expect(isTextStyleDirty(undefined)).toBe(false);
    expect(isTextStyleDirty(DEFAULT_TEXT_STYLE)).toBe(false);
  });

  it("改任意一项就算改动", () => {
    expect(isTextStyleDirty({ align: "center" })).toBe(true);
    expect(isTextStyleDirty({ letterSpacing: 0.05 })).toBe(true);
  });

  it("改成越界值但被夹回默认，不算改动", () => {
    // 字距默认 0、最小值 -0.06；填 -999 会被夹到 -0.06，是真改动
    expect(isTextStyleDirty({ letterSpacing: -999 })).toBe(true);
    // 而 lineHeight 默认 1.6，填个正好等于默认的 1.6 不算
    expect(isTextStyleDirty({ lineHeight: 1.6 })).toBe(false);
  });
});
