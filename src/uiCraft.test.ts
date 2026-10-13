import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 手感守卫（2026-10-14）：把"UI 做工"的几条规矩钉住，别让它随时间烂回去。
 *
 * ## 为什么要有它
 *
 * 用户当面说"这些 UI 和组件太丑"。翻完两个参考站（transitions.dev / beautifului.dev）之后，
 * 能抄的**不是组件代码**（我们没 Tailwind、没 Radix），而是**手艺**。其中两条是硬规矩，
 * 抄进项目之后**必须有人看着**，否则下一个人写样式时又会写回 `transition: all`：
 *
 * 1. **不许 `transition: all`** —— 它会连带布局属性一起动（transitions.dev 的原话），
 *    该动的只有 `transform / opacity / box-shadow / 颜色`这几类合成友好的属性；
 * 2. **动效参数走令牌**（`--dur-quick` / `--dur` / `--ease-out`）—— 时长散落在规则里，
 *    以后"整体快一点"就得满仓 grep；
 * 3. **`prefers-reduced-motion` 保护** —— 前庭敏感的用户看到缩放/位移动画会真的难受；
 * 4. **` :focus-visible` 焦点环** —— 键盘用户没有它**根本不知道焦点在哪**。
 *
 * ⚠️ 这几条都是"**读源码**"式的检查（不是行为测试）。它们挡的是**写法**，
 * 行为由那些真点界面的验收（`accept-*`）挡。
 */

const ROOT = path.resolve(__dirname, "..");
const STYLE_DIR = path.join(ROOT, "src", "styles");

/** 所有样式文件拼起来（拆分之后样式在 `src/styles/*.css` + 入口）。 */
function allCss(): string {
  const files = ["styles.css", ...readdirSync(STYLE_DIR).filter((f) => f.endsWith(".css")).map((f) => `styles/${f}`)];
  return files.map((f) => readFileSync(path.join(ROOT, "src", f), "utf8")).join("\n");
}

describe("手感守卫（UI 做工的几条规矩）", () => {
  const css = allCss();
  /*
   * 手感那一节现在在自己的文件里（`craft.css`）—— 它从 `workbench.css` 分出来，
   * 是因为结构守卫（C6-5：.css ≤ 1500）在我把它追加进 `workbench.css` 时当场拦下。
   * 取**最后一处**同名规则：覆盖块追加在文件末尾，`indexOf` 会拿到开头那条旧规则。
   */
  const craft = readFileSync(path.join(STYLE_DIR, "craft.css"), "utf8");
  const lastBlock = (selector: string) => {
    const at = craft.lastIndexOf(`${selector} {`);
    return at < 0 ? "" : craft.slice(at, craft.indexOf("}", at) + 1);
  };

  it("① 不许 `transition: all`（它会连带布局属性一起动）", () => {
    /*
     * ⚠️ 判定前**必须去注释**：这条守卫第一版把 theme.css 里我自己写的那句说明
     * （"transition: all 会触发不需要的属性…"）当成了违规 —— 与 C1/C2 那几条守卫踩的是同一个坑。
     */
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders: string[] = [];
    for (const file of readdirSync(STYLE_DIR).filter((f) => f.endsWith(".css"))) {
      const full = path.join(STYLE_DIR, file);
      const lines = strip(readFileSync(full, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (/transition:\s*all/.test(line)) offenders.push(`src/styles/${file}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `这些地方用了 transition: all —— 改成具名属性（transform/opacity/box-shadow/颜色）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("② 动效令牌在（时长与曲线只有一份来源）", () => {
    for (const token of ["--dur-quick", "--dur:", "--ease-out", "--ease-spring", "--focus-ring", "--on-accent"]) {
      expect(css.includes(token), `缺令牌 ${token}（手感收口那节定义的）`).toBe(true);
    }
  });

  it("③ 关键基础件真的用了令牌（不是裸写 ms）——推荐卡与发送键", () => {
    // ⚠️ 手感那一节现在在自己的文件里（craft.css）—— 它从 workbench.css 分出来，是因为
    // 结构守卫（C6-5：.css ≤ 1500）在我把它追加进 workbench.css 时当场拦下。
    /* 共用 describe 作用域里那个 `lastBlock`（它读的正是 craft.css）。 */
    expect(lastBlock(".wb-suggestion"), "推荐卡没走动效令牌").toContain("var(--dur-quick)");
    expect(lastBlock(".wb-send"), "发送键没走动效令牌").toContain("var(--dur-quick)");
  });

  it("④ `prefers-reduced-motion` 保护 + `:focus-visible` 焦点环都在", () => {
    expect(css, "缺 reduced-motion 保护").toContain("prefers-reduced-motion: reduce");
    expect(css, "缺 focus-visible 焦点环").toContain(":focus-visible");
  });

  /*
   * ⑤ 板块边界阴影（2026-10-14 主人指出"完全分不出来"）。
   *
   * 为什么值得一条守卫：这四块（左栏 / 工作区 / 画布 / 右摘要）都是**同一个底色**，
   * 边界只靠一根 1px 的 `--line`。阴影是**唯一**让眼睛看出"这是几块"的东西，
   * 而它恰恰是最容易被后来者当成"装饰"顺手删掉的（删了不会有任何行为变化，
   * 只有人看着别扭）。所以在这里钉住"存在、走令牌、两个主题都有"。
   */
  it("⑤ 四个板块之间真的有边界阴影，且走主题令牌", () => {
    const right = css.match(/--edge-shadow-right:\s*[^;]+;/);
    const left = css.match(/--edge-shadow-left:\s*[^;]+;/);
    expect(right, "没有 --edge-shadow-right 令牌").not.toBeNull();
    expect(left, "没有 --edge-shadow-left 令牌").not.toBeNull();
    /* 深色主题一套（深底上浅阴影看不见），所以令牌必须定义两次 */
    expect((css.match(/--edge-shadow-right:/g) ?? []).length, "边界阴影只有浅色一套").toBeGreaterThanOrEqual(2);
    for (const [sel, token] of [
      [".wb-nav", "var(--edge-shadow-right)"],
      [".wb-canvas", "var(--edge-shadow-left)"],
      [".wb-summary", "var(--edge-shadow-left)"],
      [".wb-composer", "var(--shadow-card)"],
    ]) {
      expect(lastBlock(sel), `${sel} 没走边界阴影（${token}）`).toContain(token);
    }
    /* 四个板块里不许有谁把阴影就地写成 rgba —— 那会绕开深色主题与棘轮 */
    for (const sel of [".wb-nav", ".wb-canvas", ".wb-summary", ".wb-composer"]) {
      expect(lastBlock(sel), `${sel} 把阴影写成了硬编码颜色`).not.toMatch(/box-shadow:[^;]*rgba\(/);
    }
  });

  /*
   * ⑥ 焦点环只准有一条，且不许用品牌蓝（2026-10-14 主人的原话：
   * 「雷霆大描边…我不要描边，我也不要突兀的蓝色」）。
   *
   * 当时的样子是三层叠：全局 `2px solid var(--accent)` +
   * 输入区容器"边框变蓝 + 3px 蓝光" + 内层 textarea 自己那圈 outline ——
   * 鼠标一点进输入区，三圈蓝色一起亮。`better-accessibility` 的取向是
   * **一个指示够了**：容器亮，内层就别再套。
   *
   * 这条守的是"别退回去"：焦点环必须走 `--focus-ring`（中性墨色），
   * 且不许在 `:focus-within` 上加发光。
   */
  it("⑥ 焦点环走中性令牌、只有一条、且不带发光", () => {
    /* ⚠️ 必须锚在行首：`craft.css` 里还有 `.wb-composer-input:focus-visible`，
       不锚就会匹配到那一条（第一版就是这么错的）。 */
    const global = css.match(/^:focus-visible\s*\{[^}]*\}/m);
    expect(global, "找不到全局 :focus-visible 规则").not.toBeNull();
    expect(global![0], "焦点环用了品牌蓝（主人明确不要）").not.toContain("var(--accent)");
    expect(global![0], "焦点环没走 --focus-ring 令牌").toContain("var(--focus-ring)");
    /* 容器级焦点反馈不许带发光（`box-shadow: 0 0 0 3px …` 那一类） */
    /*
     * 容器级焦点反馈：**只准在键盘聚焦时出现**，且不许带发光。
     *
     * 为什么必须是 `:has(:focus-visible)`：`textarea` 被**鼠标**点中时浏览器也算它
     * `:focus-visible`，只写 `:focus-within` 就会"鼠标一点就描一圈" ——
     * 那正是主人说的"雷霆大描边"第二次复发的原因。
     */
    for (const sel of [".wb-composer:has(:focus-visible)", ".wb-searchbox:has(:focus-visible)"]) {
      const block = lastBlock(sel);
      expect(block, `${sel} 不见了（焦点反馈被删了？）`).not.toBe("");
      expect(block, `${sel} 又加上了发光`).not.toMatch(/box-shadow/);
    }
    /* 鼠标态：`composer` / `searchbox` 的 `:focus-within` 规则不许再存在 */
    expect(css, "鼠标点进输入区又开始描边了（`:focus-within` 又回来了）").not.toMatch(
      /^\s*\.wb-(composer|searchbox):focus-within/m,
    );
    /* 内层输入框不许再套第二圈：必须显式写掉 */
    expect(css, "输入区里的 textarea 没有取消第二圈焦点环").toContain(".wb-composer-input:focus-visible");
    /* 焦点环取值必须中性（rgba 的黑/白），不能用彩色 */
    const token = css.match(/--focus-ring:\s*([^;]+);/);
    expect(token, "没有 --focus-ring 令牌").not.toBeNull();
    expect(token![1], `焦点环颜色不是中性的：${token![1]}`).toMatch(/rgba\(\s*(16,\s*24,\s*40|255,\s*255,\s*255)/);
  });
});
