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

describe("手感守卫（UI 做工的四条规矩）", () => {
  const css = allCss();

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
    const wb = readFileSync(path.join(STYLE_DIR, "craft.css"), "utf8");
    /*
     * ⚠️ 取**最后一处**同名规则：手感收口那一节是追加在文件末尾的覆盖块，
     * `indexOf` 拿到的是文件开头的旧规则（第一版就是这么误报的）。
     */
    const lastBlock = (selector: string) => {
      const at = wb.lastIndexOf(`${selector} {`);
      return at < 0 ? "" : wb.slice(at, wb.indexOf("}", at) + 1);
    };
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
    /** 取某个选择器**最后一次**出现的规则块（后者覆盖前者，所以看最后那条才算数）。 */
    const blocks = readFileSync(path.join(STYLE_DIR, "craft.css"), "utf8");
    const lastBlock = (selector: string) => {
      const at = blocks.lastIndexOf(`${selector} {`);
      return at < 0 ? "" : blocks.slice(at, blocks.indexOf("}", at) + 1);
    };
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
});
