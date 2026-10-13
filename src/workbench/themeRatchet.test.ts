import { readFileSync, readdirSync } from "node:fs";

/*
 * ⚠️ C6-3 把 `src/styles.css`（6015 行）按区域拆成了 `src/styles/*.css` + 一串 `@import`。
 * 这条守卫原来**只读那一个文件** —— 拆分之后它扫了个空，于是"看起来还在检查"其实什么都没查
 * （`themeRatchet` 甚至直接报"两类都要非平凡"，那正是"检查在空转"的自白）。
 *
 * 现在读**整个样式树**：入口 + `src/styles/` 下全部 css（按文件名排序，顺序无关紧要，
 * 因为这些守卫是在"找某条规则/某个变量在不在"，不是在比层叠顺序）。
 */
function readAllCss(dir = "src"): string {
  const files = [`${dir}/styles.css`, ...readdirSync(`${dir}/styles`).filter((f) => f.endsWith(".css")).sort().map((f) => `${dir}/styles/${f}`)];
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}
import { describe, expect, it } from "vitest";

/**
 * 棘轮：**工作台样式里硬编码颜色的规则数不许再涨**。
 *
 * ## 为什么需要这条
 * 「外观（深色主题）」还没做。实测（`.verify/measure-theme.py`）：
 * 工作台相关规则 347 条里，用主题变量的 **0 条**、含硬编码颜色的 **74 条**。
 *
 * 也就是说**深色主题的成本 = 那 223 条**。而只要我还在往工作台加界面
 * （这几轮一直在加），这个数就会**悄悄往上涨** —— 涨到某个程度，
 * "以后再做"就变成了"做不动了"。
 *
 * 棘轮的作用正是这个：**允许改小，不允许改大**。
 * 下次真做深色主题时，改小它；在那之前，它把这个成本钉在 223。
 *
 * ## 为什么把它写进测试而不是留个脚本
 * `.verify/measure-theme.py` 是我手动跑的 —— 手动跑的东西不会在有人加样式时提醒他。
 * 放进 vitest 才会在 `pnpm test` 里拦下来。
 */

/** 当前基线：不许超过这个数（改小了就把这里也改小）。 */
const MAX_HARDCODED_RULES = 1;


/** 粗略切规则：`选择器 { 声明 }`。 */
function rules(text: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

const COLOR_DECL = /(?:^|;)\s*(background|background-color|color|border|border-color|box-shadow)\s*:\s*([^;]+)/;
const VAR_USE = /var\(--/;
const HEX = /#[0-9a-fA-F]{3,8}/;
const RGB = /rgba?\(/;

/**
 * 数一数工作台（`.wb`，不含 `.wb-canvas`）里有多少条规则写了硬编码颜色。
 *
 * @returns 各计数
 */
function count(): { wbRules: number; hardRules: number; varRules: number } {
  const all = rules(readAllCss());
  let wbRules = 0;
  let hardRules = 0;
  let varRules = 0;
  for (const { selector, body } of all) {
    if (selector.includes("wb-canvas")) continue;
    if (!selector.includes(".wb")) continue;
    wbRules += 1;
    const decls = body.match(new RegExp(COLOR_DECL.source, "g")) ?? [];
    const values = decls.join(";");
    if (VAR_USE.test(values)) varRules += 1;
    if (HEX.test(values) || RGB.test(values)) hardRules += 1;
  }
  return { wbRules, hardRules, varRules };
}

describe("主题棘轮：深色主题的成本不许再涨", () => {
  it(`**含硬编码颜色的工作台规则不超过 ${MAX_HARDCODED_RULES} 条**`, () => {
    const { hardRules } = count();
    expect(
      hardRules,
      [
        `工作台里含硬编码颜色的规则从 ${MAX_HARDCODED_RULES} 涨到了 ${hardRules}。`,
        "这些颜色是「深色主题还没做」的成本 —— 每加一条，以后要改的就多一条。",
        "新增样式请优先用 var(--…)（.wb 里那套变量就是为此存在的），",
        "或者如果这次确实是把它改好了，就把本文件里的基线数字改小。",
      ].join("\n"),
    ).toBeLessThanOrEqual(MAX_HARDCODED_RULES);
  });

  it("**两类都要非平凡**（否则说明切规则的正则坏了、这条棘轮是假的）", () => {
    const { wbRules, hardRules } = count();
    // 基线与实测规模对得上，否则说明切规则的正则坏了、这条棘轮是假的
    expect(wbRules).toBeGreaterThan(300);
    expect(hardRules).toBeGreaterThan(0);
  });

  /**
   * 用户看到的数字必须与实测一致。
   *
   * 这条守卫的来历：设置里「外观」那行的说明原本写着"223 条写死了浅色"，
   * 而那时实际已经降到 8 条 —— **过时的说法**。这类"写着的事实不成立"
   * 不报错、不崩，只有读那句话的人才会被误导。
   *
   * 后来「外观」那行做成了**真开关**，那句说明没了 —— 但守卫不能跟着消失：
   * 改成扫**所有**用户可见文案（todo 与 title）里出现的"N 处硬编码颜色"，
   * 只要还写着，就必须与测量一致；一处都没写时它自然通过。
   */
  it("用户可见文案里凡写了「N 处硬编码颜色」，必须与实测一致", () => {
    const { hardRules } = count();
    const src = readFileSync("src/workbench/Workbench.tsx", "utf8");
    const claims = [...src.matchAll(/(\d+)\s*处硬编码颜色/g)].map((m) => Number(m[1]));

    const wrong = claims.filter((n) => n !== hardRules);
    expect(
      wrong,
      `文案里写着 ${wrong.join("、")} 处，实测是 ${hardRules} 处 —— 数字要跟着测量走。`,
    ).toEqual([]);

    // 自检：这条检查确实在读源文件（读不到就该怀疑它是不是空转）
    expect(src.length).toBeGreaterThan(1000);
  });
});
