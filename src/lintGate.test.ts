import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * lint 门禁**真的在判**（**审计 P222**）。
 *
 * ## 缺陷形状
 *
 * `.oxlintrc.json` 原来是 `"categories": { "correctness": "off" }` + 两条规则 ——
 * 也就是说 `pnpm lint`（以及 CI 的 lint 步骤、`pnpm build` 链里的那次）
 * **实际只有 `no-unused-vars` / `no-undef` 两条规则在跑**。
 * 所有 correctness 类形状（`no-dupe-keys`、`no-self-assign`、`no-const-assign`、
 * `no-unreachable`、`valid-typeof`……）**在 CI 里永远不会红** ——
 * 一道"看着像门禁"的门，实际只挡两件事。
 *
 * ## 这一组钉两件事
 *
 * 1. `correctness` 必须是开的（关掉它 = 退回缺陷形状，这条会红）；
 * 2. **豁免只能少不能多**：哪些规则被单独关掉是一张**棘轮**，
 *    写在下面并带理由。想再加一条豁免就必须先改这个文件 ——
 *    否则"关掉 correctness 再加一堆 off"会悄悄把门禁掏空，而没人发现
 *    （这正是 P222 当初的路径）。
 */

const RAW = readFileSync(path.resolve(__dirname, "../.oxlintrc.json"), "utf8");
const CONFIG = JSON.parse(RAW) as {
  categories?: Record<string, unknown>;
  rules?: Record<string, string>;
};

/**
 * 目前**被单独关掉**的规则（棘轮）。
 *
 * 为什么这几条被关：它们在**别人的文件中**已有既存违背（本轮不做那些文件），
 * 而它们都是**风格类**、不是"拿命的那一批"。名单是按"这条规则关掉会不会
 * 让人写出真 bug"逐条过过的：
 *
 * | 规则 | 为什么可以先关 |
 * |---|---|
 * | `unicorn/no-useless-spread` 等四条 unicorn | 纯风格（少写一次展开），与正确性无关 |
 * | `no-useless-escape` | 正则里多写一个反斜杠：啰嗦，不是错 |
 * | `no-control-regex` | `markdown.ts` 的行内代码占位符**故意**用 `\u0000`（有注释） |
 * | `no-irregular-whitespace` | 中文文案里夹了全角空格 |
 * | `no-constant-binary-expression` | 测试里故意写恒真表达式当"判据存在性"的证据 |
 * | `no-unsafe-optional-chaining` | `?.` 多余但不改语义 |
 *
 * ⚠️ 谁想把这份名单**加长**，先回答一个问题：加的这一条会不会让
 * "写错了但 CI 全绿"重新成为可能？会 → 不许加，去修那几个文件。
 */
const ALLOWED_OFF = [
  "unicorn/no-useless-fallback-in-spread",
  "unicorn/no-useless-spread",
  "unicorn/no-useless-length-check",
  "unicorn/prefer-string-starts-ends-with",
  "no-useless-escape",
  "no-control-regex",
  "no-irregular-whitespace",
  "no-constant-binary-expression",
  "no-unsafe-optional-chaining",
];

describe(".oxlintrc.json：门禁强度（审计 P222）", () => {
  it("⭐ `correctness` 是开着的（关掉它 = 退回「只有两条规则」的缺陷形状）", () => {
    expect(CONFIG.categories?.correctness, "correctness 被关掉了：门禁又只剩两条规则").toBe("error");
  });

  it("⭐ 豁免名单是**棘轮**：只能少，不能多（多一条要在这里说明理由）", () => {
    const off = Object.entries(CONFIG.rules ?? {})
      .filter(([, v]) => v === "off")
      .map(([k]) => k)
      .sort();
    expect(off, "多出来的豁免：每一条都要么修掉，要么写进 ALLOWED_OFF 并说明为什么它不关正确性").toEqual(
      [...ALLOWED_OFF].sort(),
    );
  });

  it("拿命的那几条 correctness 规则没被豁免（这是 P222 真正要拦的东西）", () => {
    const rules = CONFIG.rules ?? {};
    for (const key of ["no-dupe-keys", "no-self-assign", "no-const-assign", "no-unreachable", "valid-typeof"]) {
      expect(rules[key], `${key} 被显式关掉了 —— 它正是 P222 点名的形状`).not.toBe("off");
    }
  });

  it("原来的两条规则仍在（改了别处不能顺手把它们拿掉）", () => {
    const rules = CONFIG.rules ?? {};
    expect(rules["no-unused-vars"]).toBe("error");
    expect(rules["no-undef"]).toBe("error");
  });
});
