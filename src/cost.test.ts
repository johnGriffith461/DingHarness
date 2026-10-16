import { describe, expect, it } from "vitest";
import { costNote, fabricatedCost, sumUsage, usageRows, usageTotal } from "@shared/cost";

/**
 * C5：「消耗」这个数的唯一说法。
 *
 * ## 为什么这些断言存在
 *
 * 本体显示的是「消耗 0.48」，而实机读数写明它**按额度计量、不是 token**（`docs/HANDOFF.md:1695`）。
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 本机版没有额度体系 —— 那个数算不出来。所以我们显示的是**按字数的估算**，
 * 而**真实用量**（provider 给的 tokens）另行如实说出。
 *
 * 这条边界很细：一旦有人把估算包装成"额度"、或者把单位偷偷换成 tokens，
 * 界面就在说一件不真的事。断言把这个边界钉住。
 */

describe("fabricatedCost（本机版那个估算数）", () => {
  it("说得越多，数越大（同一个口径下可比）", () => {
    expect(fabricatedCost("短")).toBeLessThan(fabricatedCost("长".repeat(400)));
  });

  it("空文本也有底座 0.10（不是 0、不是负数）", () => {
    /*
     * ⚠️ 2026-10-16（审计 G53.l）：原来除了 `toBe(0.1)` 还挂着一条
     * `toBeGreaterThanOrEqual(0.01)` —— 在 `0.1 > 0.01` 之下它**恒真**（而且那句
     * `Math.max(0.01, …)` 是死代码，已删）。现在钉**底座本身**：
     * 空文本 = 0.10，且它随文本单调不降（这才是"可比较"这条口径）。
     */
    expect(fabricatedCost("")).toBe(0.1);
    expect(fabricatedCost("a".repeat(400))).toBeGreaterThan(fabricatedCost(""));
  });

  it("保留两位（界面上就是「消耗 0.48」这种写法）", () => {
    expect(String(fabricatedCost("随便一段话"))).toMatch(/^\d+(\.\d{1,2})?$/);
  });

  it("喂 null/undefined 不炸（调用方在恢复路径上可能拿到空的）", () => {
    expect(fabricatedCost(null as unknown as string)).toBe(0.1);
    expect(fabricatedCost(undefined as unknown as string)).toBe(0.1);
  });
});

describe("costNote（hover 里那句如实说明）", () => {
  it("⭐ 明说这是**估算**，且明说本机没有额度体系（不许说成「额度」的真值）", () => {
    const note = costNote(0.48);
    expect(note).toContain("估算");
    expect(note).toContain("没有额度体系");
    expect(note).toContain("0.48");
  });

  it("有真实用量就一起说出来（输入/输出 tokens）", () => {
    expect(costNote(0.48, { inputTokens: 2961, outputTokens: 44 })).toContain("2961 输入 / 44 输出 tokens");
  });

  it("拿不到用量时不提那一句（**不编**）", () => {
    expect(costNote(0.48)).not.toContain("tokens");
    expect(costNote(0.48, {})).not.toContain("tokens");
  });

  it("只有一半（比如只拿到输出）也照说，缺的那半写 ?（不假装是 0）", () => {
    const note = costNote(0.48, { outputTokens: 44 });
    expect(note).toContain("? 输入 / 44 输出 tokens");
  });
});

/**
 * 输入区那个「用量」弹层里的几行（2026-10-14）。
 *
 * 判据与 `costNote` 同源：**拿不到的行就不出现**（不许用 0 冒充"没有数据"）；
 * 能推出来的要标明是推的。
 */
describe("usageRows（缓存命中 / 缓存读取 / 未缓存输入 / 输出 / 吞吐量）", () => {
  it("provider 给了缓存明细就如实分行，并算命中率与吞吐量", () => {
    const rows = usageRows({
      inputTokens: 10000,
      outputTokens: 500,
      cacheReadTokens: 9000,
      noCacheTokens: 1000,
      elapsedMs: 5000,
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.cacheRead).toBe("9000");
    expect(byKey.noCache).toBe("1000");
    expect(byKey.cacheHit).toBe("90%");
    expect(byKey.output).toBe("500");
    expect(byKey.tps).toBe("100.0 tok/s"); // 500 tokens ÷ 5 秒
  });

  it("⭐ 缺的字段**不出现**（不是显示 0）", () => {
    const rows = usageRows({ inputTokens: 100, outputTokens: 20 });
    expect(rows.map((r) => r.key)).toEqual(["output"]);
  });

  it("只给总数与缓存读取时，「未缓存输入」由减法推出来，并在 title 里标明是推的", () => {
    const rows = usageRows({ inputTokens: 1000, cacheReadTokens: 800 });
    const noCache = rows.find((r) => r.key === "noCache");
    expect(noCache?.value).toBe("200");
    expect(noCache?.note).toBeTruthy();
  });

  it("没有耗时就**不算**吞吐量（除数是它，编不出来）", () => {
    const rows = usageRows({ outputTokens: 500, cacheReadTokens: 1, noCacheTokens: 1 });
    expect(rows.some((r) => r.key === "tps")).toBe(false);
  });

  it("一个数都没有时不返回任何行（空态由界面自己说）", () => {
    expect(usageRows(undefined)).toEqual([]);
    expect(usageRows({})).toEqual([]);
  });

  it("sumUsage 逐项求和；一个数都没有时给 undefined（界面就不显示数）", () => {
    expect(sumUsage([{ inputTokens: 10, outputTokens: 2 }, undefined, { inputTokens: 5, cacheReadTokens: 3 }])).toEqual({
      inputTokens: 15,
      outputTokens: 2,
      cacheReadTokens: 3,
    });
    expect(sumUsage([undefined, {}])).toBeUndefined();
    expect(usageTotal({ inputTokens: 15, outputTokens: 2 })).toBe(17);
    expect(usageTotal(undefined)).toBeNull();
  });
});
