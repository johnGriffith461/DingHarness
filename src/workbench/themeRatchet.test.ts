import { readFileSync, readdirSync } from "node:fs";

/*
 * ⚠️ C6-3 把 `src/styles.css`（6015 行）按区域拆成了 `src/styles/*.css` + 一串 `@import`。
 * 这条守卫原来**只读那一个文件** —— 拆分之后它扫了个空，于是"看起来还在检查"其实什么都没查
 * （`themeRatchet` 甚至直接报"两类都要非平凡"，那正是"检查在空转"的自白）。
 *
 * 现在读**整个样式树**：入口 + `src/styles/` 下全部 css（按文件名排序，顺序无关紧要，
 * 因为这些守卫是在"找某条规则/某个变量在不在"，不是在比层叠顺序）。
 */
function readAllCssFiles(dir = "src"): Array<{ file: string; text: string }> {
  const files = [
    `${dir}/styles.css`,
    ...readdirSync(`${dir}/styles`)
      .filter((f) => f.endsWith(".css"))
      .sort()
      .map((f) => `${dir}/styles/${f}`),
  ];
  return files.map((f) => ({ file: f, text: readFileSync(f, "utf8") }));
}
import { describe, expect, it } from "vitest";

/**
 * 棘轮：**工作台样式里硬编码颜色的规则数不许再涨**。
 *
 * ## 为什么需要这条
 * 「外观（深色主题）」还没做。实测（`.verify/measure-theme.py`）：  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
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
 * `.verify/measure-theme.py` 是我手动跑的 —— 手动跑的东西不会在有人加样式时提醒他。  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * 放进 vitest 才会在 `pnpm test` 里拦下来。
 */

/**
 * 当前基线：不许超过这个数（改小了就把这里也改小）。
 *
 * ⚠️ 2026-10-14 从 1 降到 0（`.wb-media-cell.is-broken::before` 的斜纹底换了令牌）。
 *
 * ⚠️⚠️ 2026-10-16（审计 G23）：那个 **0 是假象** —— 判据有四处漏检
 * （属性白名单窄 / 值只认 hex 与 rgb() / 作用域要求选择器含 `.wb` /
 * 一条规则里出现 `var(--` 就整条算"走变量"）。四处补上之后真实数字是 **11**：
 *
 *   · `chat.css` 10 条：`.chat-tabs button.on` / `.chat-warn` / `.chat-msg.user .chat-bubble`
 *     / `.chat-msg.is-error .chat-bubble` / `.chat-msg-error` / `.chat-retry` / `.chat-retry:hover`
 *     / `.chat-error` / `.chat-probe:hover:not(:disabled)` / `.chat-note`
 *   · `craft.css` 1 条：`.nv-btn.is-ok`
 *
 * 这就是"深色主题还欠的账"，**挂在明面上**（原来的 0 让它隐形了）。
 * 把这几条改成令牌之后，把这里的数字改小 —— 只许变小。
 * （只定义自定义属性的规则不算：`.wb { --fg: … }` 那种色板本身要在那里写死色值。）
 */
const MAX_HARDCODED_RULES = 11;


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

/**
 * 硬编码颜色的**值**判据（2026-10-16，审计 G23：原来只认 `#hex` 与 `rgb()`）。
 *
 * 补上的三类实测漏检：
 *   · **函数色**：`hsl()` / `oklch()` / `color-mix()` / `lab()` / `lch()`；
 *   · **命名色**：`white` / `black` / `gray` / `red` …（全仓确实用过）；
 *   · **`transparent` 之外的裸色词**（`transparent`/`currentColor`/`inherit` 不算硬编码）。
 */
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNC_COLOR = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix|color)\s*\(/;
const NAMED_COLOR =
  /(?:^|[\s:,])(?:white|black|gray|grey|red|green|blue|orange|yellow|purple|pink|brown|cyan|magenta|silver|gold|navy|teal|olive|maroon|lime|aqua|fuchsia)\b/i;
const NOT_A_COLOR = /^(?:transparent|currentcolor|inherit|initial|unset|none)$/i;

/** 一条声明的值里有没有硬编码颜色。 */
function valueHasHardcodedColor(value: string): boolean {
  const parts = value
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length === 1 && NOT_A_COLOR.test(parts[0]!)) return false;
  return HEX.test(value) || FUNC_COLOR.test(value) || NAMED_COLOR.test(value);
}

/**
 * 把一条规则的声明逐条拆开（2026-10-16，审计 G23 的第四类漏检）。
 *
 * ⚠️ 原来判的是"这条规则里**有没有** `var(--`" —— 于是
 * `.x { color: var(--fg); background: #fff; }` 被整条算成"走变量"，
 * 那条 `#fff` 就这么漏掉了（实测里这类混合写法不止一处）。
 * 现在**逐条声明**判：只要有一条的值是硬编码颜色，这条规则就算硬编码。
 */
function declarations(body: string): string[] {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
}

/**
 * 数一数工作台（`.wb`，不含 `.wb-canvas`）里有多少条规则写了硬编码颜色。
 *
 * @returns 各计数
 */
/**
 * 数一数工作台里有多少条规则写了硬编码颜色。
 *
 * ## 作用域（2026-10-16，审计 G23 的第三类漏检）
 *
 * 原来是"选择器里必须含 `.wb` 字面量"—— 而**工作台自己的那几张样式表**
 * （`workbench.css` / `craft.css` / `panels.css` / `chat.css`）里，
 * 规则常常直接写 `.layer-panel` / `.side` 这种**不带 `.wb` 前缀**的类名 ——
 * 那些规则整片漏检。现在按**文件**认作用域（与画布那边同一套做法）：
 *   工作台 = 上述四张表里的规则 + 其它表里选择器含 `.wb` 的规则；
 *   画布（`canvas.css` / `canvas-nodes.css` 与含 `wb-canvas` 的选择器）**排除**——
 *   那是深色孤岛，它自己有一套变量（由 `canvasThemeVars.test.ts` 盯着）。
 */
const WORKBENCH_FILES = ["workbench.css", "craft.css", "panels.css", "chat.css"];

function count(files: Array<{ file: string; text: string }> = readAllCssFiles()): {
  wbRules: number;
  hardRules: number;
  varRules: number;
} {
  let wbRules = 0;
  let hardRules = 0;
  let varRules = 0;
  for (const { file, text } of files) {
    const byFile = WORKBENCH_FILES.some((f) => file.endsWith(f));
    /* ⚠️ 切规则前**必须先去掉注释**（本项目第三次踩这个坑了）：注释紧贴规则上方时
       会被 `([^{}]+)\{` 当成"选择器"文本 —— 而注释里出现 `#hex` 就会被误报成硬编码。 */
    for (const { selector, body } of rules(text.replace(/\/\*[\s\S]*?\*\//g, ""))) {
      if (selector.includes("wb-canvas")) continue;
      if (!byFile && !selector.includes(".wb")) continue;
      const decls = declarations(body);
      wbRules += 1;
      let usesVar = false;
      let hard = false;
      for (const decl of decls) {
        const at = decl.indexOf(":");
        if (at <= 0) continue;
        const prop = decl.slice(0, at).trim();
        const value = decl.slice(at + 1);
        /*
         * **自定义属性本身不算"用色"**：`.wb { --fg: #1b1a14; }` 就是色板 ——
         * 在那里写死色值是它的职责（审计 G23 只该盯"用色"，不该盯"定义色"）。
         *
         * ⚠️ 要**逐条**跳过，不是"整条规则全是变量才跳过"：`.wb` 这种块里还混着
         * `color-scheme: light` 之类的非颜色声明 —— 整条判会把色板块整体误算成债务
         * （实测把它算进来会多报 3 条，而那 3 条全是色板）。
         */
        if (prop.startsWith("--")) continue;
        if (/var\(--/.test(value)) usesVar = true;
        if (valueHasHardcodedColor(value)) hard = true;
      }
      if (usesVar) varRules += 1;
      if (hard) hardRules += 1;
    }
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

  it("**切规则的正则真的在工作**（拿构造的样式验它，不靠仓库里恰好还剩一条）", () => {
    const { wbRules } = count();
    // 基线与实测规模对得上，否则说明切规则的正则坏了、这条棘轮是假的
    expect(wbRules).toBeGreaterThan(300);
    /*
     * ⚠️ 2026-10-14：棘轮降到 0 之后，原来那条 `expect(hardRules).toBeGreaterThan(0)`
     * 就**立不住了** —— 它靠"仓库里恰好还剩一条硬编码"来证明正则没坏。
     * 而"希望仓库里长期留着一条坏样本"本身就是个坏判据（它逼你为了测试而留脏东西），
     * 所以换成拿一段**构造**的样式直接验解析：该数出来的必须数出来。
     */
    /* 自测用的样式要带**文件名**（作用域现在按文件认：放进工作台那几张表之一） */
    const sampleCount = (css: string) => count([{ file: "workbench.css", text: css }]);
    const sample = sampleCount(".wb-sample { background: #abcdef; }\n.wb-sample2 { color: var(--fg); }");
    expect(sample.hardRules, "含 #hex 的规则没被数成硬编码 —— 这条棘轮在空转").toBe(1);
    expect(sample.varRules, "走变量的规则没被数出来").toBe(1);
    /*
     * ⚠️ 2026-10-16（审计 G23）：自测要覆盖**补上的四处**，否则它们又会悄悄退化：
     *   ① 函数色与命名色（原来只认 hex / rgb）；
     *   ② 混着写的规则（`var(--fg)` + `#fff` 同一条 —— 原来整条算"走变量"）；
     *   ③ 不带 `.wb` 前缀的选择器（把文件放进白名单才认）。自测走不了文件名，
     *      所以这里只验判据本身，作用域由下面那条"覆盖下限"兜着。
     */
    const mixed = sampleCount(".wb-a { color: var(--fg); background: #fff; }");
    expect(mixed.hardRules, "同一规则里 var + 硬编码漏了 —— 第四类漏检又回来了").toBe(1);
    expect(sampleCount(".wb-b { color: hsl(0 0% 100%); }").hardRules, "hsl() 没被抓").toBe(1);
    expect(sampleCount(".wb-c { color: White; }").hardRules, "命名色没被抓").toBe(1);
    expect(sampleCount(".wb-d { color: transparent; }").hardRules, "transparent 被误判成硬编码了").toBe(0);
    expect(sampleCount(".wb-e { --fg: #123456; }").hardRules, "色板本身（只定义变量）不该算进债务").toBe(0);
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
