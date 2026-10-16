import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIZE_CHOICE,
  inferSize,
  normalize,
  parseSize,
  PRESET_RATIOS,
  resolveChoice,
  resolveSize,
  resolveWH,
  MAX_SIDE,
  MAX_PIXELS,
  MIN_PIXELS,
  SIZE_MULTIPLE,
} from "@shared/imageSize";

/**
 * 这张表的期望值**全部抄自规格文档**（`lunora-image-size-rules.md`，标注 authoritative，  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * 来自真实浏览器逐项实测）。不是我推出来的 —— 所以任何一条对不上都是实现有问题，不是"差不多"。
 */

describe("normalize —— 文档 §4.3 自检对照表", () => {
  const cases: Array<[number, number, string]> = [
    [1024, 1024, "1024x1024"],
    [2000, 2000, "2000x2000"],
    [1000, 1000, "1008x1008"],
    [1023, 767, "1024x768"],
    [1920, 1080, "1920x1088"],
    [1024, 3000, "1024x3008"],
    [800, 600, "944x720"],
    [300, 300, "816x816"],
    [1, 1, "816x816"],
    [5000, 5000, "2880x2880"],
    [4096, 4096, "2880x2880"],
    [3840, 3840, "2880x2880"],
    [9000, 16, "1408x480"],
  ];
  for (const [w, h, want] of cases) {
    it(`${w}x${h} → ${want}`, () => {
      const [a, b] = normalize(w, h);
      expect(`${a}x${b}`).toBe(want);
    });
  }

  it("输出永远满足规格的四条硬约束", () => {
    const samples: Array<[number, number]> = [
      [1, 1],
      [9999, 7],
      [3000, 3000],
      [513, 1027],
      [72, 4096],
      [8294400, 1],
    ];
    for (const [w, h] of samples) {
      const [a, b] = normalize(w, h);
      expect(a % SIZE_MULTIPLE).toBe(0);
      expect(b % SIZE_MULTIPLE).toBe(0);
      expect(Math.max(a, b)).toBeLessThanOrEqual(MAX_SIDE);
      expect(Math.max(a / b, b / a)).toBeLessThanOrEqual(3);
      const area = a * b;
      expect(area).toBeGreaterThanOrEqual(MIN_PIXELS);
      expect(area).toBeLessThanOrEqual(MAX_PIXELS);
    }
  });
});

describe("resolveSize —— 文档 §3 档位 × 比例权威表", () => {
  const table: Record<string, [string, string, string]> = {
    "1:1": ["1024x1024", "2048x2048", "2880x2880"],
    "3:2": ["1536x1024", "2160x1440", "3456x2304"],
    "2:3": ["1024x1536", "1440x2160", "2304x3456"],
    "16:9": ["1280x720", "2560x1440", "3840x2160"],
    "9:16": ["720x1280", "1440x2560", "2160x3840"],
    "4:3": ["1024x768", "2048x1536", "3200x2400"],
    "3:4": ["768x1024", "1536x2048", "2400x3200"],
    // ⚠️ 21:9 走的是搜索分支（约分后 7:3，表里没有），不是那张死代码表
    "21:9": ["1920x816", "3120x1344", "3840x1648"],
  };
  for (const [ratio, [k1, k2, k3]] of Object.entries(table)) {
    it(`${ratio} → 1K/${k1}  2K/${k2}  4K/${k3}`, () => {
      expect(resolveSize("1K", ratio)).toBe(k1);
      expect(resolveSize("2K", ratio)).toBe(k2);
      expect(resolveSize("4K", ratio)).toBe(k3);
    });
  }

  it("21:9 不能用死代码那三个值（文档 §7 第 1 条点名）", () => {
    const dead = ["1280x544", "2560x1088", "3840x1600"];
    for (const tier of ["1K", "2K", "4K"] as const) {
      expect(dead).not.toContain(resolveSize(tier, "21:9"));
    }
  });

  it("4K 的 1:1 是 2880x2880，不是 3840x3840（档位是面积上限，不是边长）", () => {
    expect(resolveSize("4K", "1:1")).toBe("2880x2880");
  });
});

describe("resolveSize —— 文档 §3.1 自定义比例", () => {
  const cases: Array<[string, string, string, string]> = [
    ["1:1", "1024x1024", "2048x2048", "2880x2880"],
    ["5:4", "1392x1120", "2288x1824", "3216x2576"],
    ["2.39:1", "1920x800", "3152x1328", "3840x1616"],
    ["21:9", "1920x816", "3120x1344", "3840x1648"],
    ["1000:999", "1248x1248", "2048x2048", "2880x2880"],
    ["9:21", "816x1904", "", ""],
  ];
  for (const [input, k1, k2, k3] of cases) {
    it(`${input}`, () => {
      expect(resolveSize("1K", input)).toBe(k1);
      if (k2) expect(resolveSize("2K", input)).toBe(k2);
      if (k3) expect(resolveSize("4K", input)).toBe(k3);
    });
  }

  it("超过 3:1 或无解 → null（界面据此置灰）", () => {
    expect(resolveSize("1K", "5:1")).toBeNull();
    expect(resolveSize("1K", "abc")).toBeNull();
    expect(resolveSize("1K", "")).toBeNull();
  });

  it("3:1 恰好合法（边界不算超）", () => {
    expect(resolveSize("1K", "3:1")).not.toBeNull();
  });

  it("分隔符 : x X × 都认", () => {
    const a = resolveSize("1K", "16:9");
    expect(resolveSize("1K", "16x9")).toBe(a);
    expect(resolveSize("1K", "16X9")).toBe(a);
    expect(resolveSize("1K", "16×9")).toBe(a);
  });
});

describe("parseSize", () => {
  it("认各种写法与小数", () => {
    expect(parseSize("1024x1024")).toEqual({ w: 1024, h: 1024 });
    expect(parseSize(" 2.39 : 1 ")).toEqual({ w: 2.39, h: 1 });
    expect(parseSize("abc")).toBeNull();
    expect(parseSize("1024")).toBeNull();
  });
});

describe("resolveChoice", () => {
  it("auto 模式给 'auto'（由调用方决定发不发 size）", () => {
    const out = resolveChoice({ ...DEFAULT_SIZE_CHOICE, mode: "auto" });
    expect(out).toEqual({ size: "auto", invalid: false, normalized: false });
  });

  it("ratio 模式走档位表", () => {
    expect(resolveChoice({ mode: "ratio", tier: "2K", ratio: "16:9", width: 1, height: 1 }).size).toBe("2560x1440");
  });

  it("非法比例标 invalid", () => {
    const out = resolveChoice({ mode: "ratio", tier: "1K", ratio: "5:1", width: 1, height: 1 });
    expect(out.invalid).toBe(true);
  });

  it("自定义宽高被规整时标 normalized（界面据此显示 ⚠）", () => {
    const out = resolveChoice({ mode: "resolution", tier: "1K", ratio: "1:1", width: 1920, height: 1080 });
    expect(out.size).toBe("1920x1088");
    expect(out.normalized).toBe(true);
  });

  it("自定义宽高本来就合规时不标 normalized", () => {
    const out = resolveChoice({ mode: "resolution", tier: "1K", ratio: "1:1", width: 1024, height: 1024 });
    expect(out.size).toBe("1024x1024");
    expect(out.normalized).toBe(false);
  });
});

describe("inferSize —— 文档 §6 反向映射", () => {
  it("1920x816 → 1K / 21:9", () => {
    expect(inferSize("1920x816")).toEqual({ tier: "1K", ratio: "21:9" });
  });

  it("档位表里的值都能反查回来", () => {
    for (const tier of ["1K", "2K", "4K"] as const) {
      for (const ratio of PRESET_RATIOS) {
        const size = resolveSize(tier, ratio);
        expect(size).not.toBeNull();
        const back = inferSize(size as string);
        /*
         * ⚠️ 2026-10-16（审计 G53.s）：原来只断 `back !== null` —— 反查把比例算错、
         * 或者把档位张冠李戴，这条都过。现在钉**比例必须一致**（反查不保证回到最小的
         * 那个档 —— 同一尺寸可能被多个档命中 —— 但**比例**是确定的）。
         */
        expect(back, `${tier}/${ratio} 的尺寸 ${size} 反查不出来`).not.toBeNull();
        expect(back!.ratio, `${tier}/${ratio} → ${size} 反查出来的比例不对`).toBe(ratio);
      }
    }
  });
});

describe("resolveWH", () => {
  it("1024x1024 原样返回", () => {
    expect(resolveWH(1024, 1024)).toBe("1024x1024");
  });

  it("1x1 被放大到像素下限", () => {
    expect(resolveWH(1, 1)).toBe("816x816");
  });
});

describe("DEFAULT_SIZE_CHOICE", () => {
  it("默认 1K / 1:1（文档 §1 的默认值）", () => {
    expect(resolveChoice(DEFAULT_SIZE_CHOICE).size).toBe("1024x1024");
  });
});
