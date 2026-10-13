import { describe, expect, it } from "vitest";
import {
  clampCrop,
  cropStyle,
  cropToPercent,
  isFullCrop,
  percentToCrop,
} from "./imageCrop";

const NATURAL = { width: 1000, height: 500 };

describe("percentToCrop / cropToPercent", () => {
  it("百分比 → 像素", () => {
    expect(percentToCrop({ x: 10, y: 20, width: 50, height: 40 }, NATURAL)).toEqual({
      x: 100,
      y: 100,
      width: 500,
      height: 200,
    });
  });

  it("像素 → 百分比，与上面互逆", () => {
    expect(cropToPercent({ x: 100, y: 100, width: 500, height: 200 }, NATURAL)).toEqual({
      x: 10,
      y: 20,
      width: 50,
      height: 40,
    });
  });
});

describe("isFullCrop", () => {
  it("未裁剪 / 等于整图都算整图", () => {
    expect(isFullCrop(undefined, NATURAL)).toBe(true);
    expect(isFullCrop({ x: 0, y: 0, width: 1000, height: 500 }, NATURAL)).toBe(true);
    expect(isFullCrop({ x: 0, y: 0, width: 999, height: 499 }, NATURAL)).toBe(true);
  });

  it("真的裁掉一部分就不算整图", () => {
    expect(isFullCrop({ x: 100, y: 0, width: 800, height: 500 }, NATURAL)).toBe(false);
  });

  it("缺原图尺寸时保守当作整图", () => {
    expect(isFullCrop({ x: 0, y: 0, width: 10, height: 10 }, undefined)).toBe(true);
  });
});

describe("clampCrop", () => {
  it("夹到原图范围内", () => {
    expect(clampCrop({ x: -50, y: -20, width: 4000, height: 900 }, NATURAL)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 500,
    });
  });

  it("宽度至少 1px", () => {
    const out = clampCrop({ x: 0, y: 0, width: 0, height: 0 }, NATURAL);
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
  });

  it("起点超出右下角时仍给合法尺寸", () => {
    const out = clampCrop({ x: 2000, y: 2000, width: 100, height: 100 }, NATURAL);
    expect(out.x).toBeLessThanOrEqual(NATURAL.width - 1);
    expect(out.width).toBeGreaterThanOrEqual(1);
  });
});

describe("cropStyle", () => {
  it("整图 / 无裁剪返回空样式（按原样展示）", () => {
    expect(cropStyle(undefined, NATURAL)).toEqual({});
    expect(cropStyle({ x: 0, y: 0, width: 1000, height: 500 }, NATURAL)).toEqual({});
  });

  it("裁剪一半时放大倍率与位移都对", () => {
    const style = cropStyle({ x: 500, y: 0, width: 500, height: 500 }, NATURAL);
    expect(style.width).toBe("200%");
    expect(style.height).toBe("100%");
    expect(style.transform).toBe("translate(-50%, 0%)");
  });
});
