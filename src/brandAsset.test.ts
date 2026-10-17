import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 品牌资产的**字面**守卫（D02，2026-10-18）。
 *
 * 产品审计说"字标还是 Dingwork"。我按审计去渲染了一次，**确实是**：
 * `logo-lockup.svg` 的路径渲染出来是 `Dingwork`，而 `brandMark.tsx` 的注释
 * 一直写着"Ding Harness 那几个字的路径" —— 注释和资产对不上，
 * 于是没有任何测试发现这件事（它不会让任何逻辑变红）。
 *
 * 这条守卫把"资产里写的是什么"钉死：读 SVG 文本、去掉标签、只看用户能看见的字。
 * 谁能改字标，就得同时改这里 —— 改字标是有意的身份动作，不该悄悄发生。
 */

const ROOT = path.resolve(__dirname, "..");
const ASSET = path.join(ROOT, "src", "assets", "logo-lockup.svg");
const BRAND = path.join(ROOT, "src", "workbench", "brandMark.tsx");

/** SVG → 用户能看见的文字（去掉标签与属性）。 */
function visibleText(svg: string): string {
  return svg
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("字标资产（D02：不许再是 Dingwork）", () => {
  const svg = readFileSync(ASSET, "utf8");

  it("⭐ 可见文字是 Ding Harness", () => {
    expect(visibleText(svg)).toBe("Ding Harness");
  });

  it("⭐ 资产里不出现 Dingwork（审计撞到的那一处）", () => {
    expect(svg).not.toMatch(/Dingwork/i);
  });

  it("「盯」的两条路径还在（换字标不该把标识本身弄丢）", () => {
    // 墨色方块字 + 朱红「丁」：各一条 path
    expect(svg).toMatch(/fill="#1b1a14"/);
    expect(svg).toMatch(/fill="#9a2f1c"/);
  });

  it("字标有字体回退栈（我们只有形状、没有「Harness」的字形路径）", () => {
    // 至少要落到 serif，别在某台机器上退成无衬线或方框
    expect(svg).toMatch(/font-family="[^"]*serif[^"]*"/);
  });

  it("无障碍名仍是 Ding Harness（读屏不该念旧名字）", () => {
    const code = readFileSync(BRAND, "utf8");
    expect(code).toContain('aria-label="Ding Harness"');
  });
});
