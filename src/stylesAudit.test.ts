import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 样式那几条的判据（2026-10-16 审计 P252 / P257 / P73 / P75 / P67+K03+P64）。
 *
 * ## 判据为什么这么写
 *
 * 这几条都落在 CSS 上，而 CSS 的"行为"没法在 node 环境里跑（没有布局引擎）——
 * 所以按本仓既有做法（`uiCraft` / `themeRatchet` / `canvasThemeVars`）**读样式源码**，
 * 但判据取**可算的关系**而不是"有没有某个字符串"：
 *   · P252：搜出所有 `outline: none`，逐条要求它要么自己带 `:focus-visible` 补偿、
 *     要么在那个**按输入模态分档**的统一规则里 —— 漏网的会红；
 *   · P73：把两个面板的 `top/right/bottom/width` 解出来，断言两个矩形**不相等**
 *     （这正是"后开的把先开的盖住"的成因）；
 *   · P75：数导出时该藏的选择器（少一个就红）；
 *   · P257：`opacity: 0` 的显形必须有 `:hover` **和**键盘那一条。
 */

/** 本文件在 `src/` 下，所以仓根是再往上一级。 */
const ROOT = path.resolve(__dirname, "..");
const STYLES = path.join(ROOT, "src", "styles");

function readCss(name: string): string {
  return readFileSync(path.join(STYLES, name), "utf8");
}

function allCss(): Array<{ name: string; text: string }> {
  return readdirSync(STYLES)
    .filter((f) => f.endsWith(".css"))
    .map((f) => ({ name: f, text: readCss(f) }));
}

/** 去掉注释（判定用）。 */
function bare(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 取某条规则块（`selector { ... }`），从第一条匹配的选择器往后到下一个 `}`。 */
function ruleBlock(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  if (open < 0 || close < 0) return "";
  return css.slice(open, close);
}

/** 取声明里某个属性的值（`undefined` = 没写）。 */
function declOf(block: string, prop: string): string | undefined {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+);`).exec(block);
  return m?.[1]?.trim();
}

/** 逐条找 `outline: none` 所在的选择器（往回到最近的 `{`）。 */
function outlineNoneSelectors(css: string): Array<{ selector: string; line: number }> {
  /* ⚠️ 只在**去注释之后**的那份上算下标：两份串混着用会取到错位的选择器（这里踩过一次） */
  const clean = bare(css);
  const out: Array<{ selector: string; line: number }> = [];
  for (const m of clean.matchAll(/outline:\s*none;/g)) {
    const before = clean.slice(0, m.index);
    const open = before.lastIndexOf("{");
    const head = before.lastIndexOf("}", open);
    out.push({
      selector: before.slice(head + 1, open).replace(/\s+/g, " ").trim(),
      line: before.split("\n").length,
    });
  }
  return out;
}

describe("P252：不许再有「自己把焦点环压掉」的输入控件", () => {
  const files = allCss();

  it("⭐ 全仓 `outline: none` 只许出现在**两处有补偿**的地方", () => {
    const offenders: string[] = [];
    for (const { name, text } of files) {
      for (const hit of outlineNoneSelectors(text)) {
        /*
         * 允许的两种形态：
         *   ① 选择器自己就带 `:focus-visible`（`craft.css` 的容器级补偿 ——
         *      "容器亮了、控件不描第二圈"）；
         *   ② `theme.css` 那条**按输入模态分档**的统一规则
         *     （`html:not([data-kb="1"]) :is(...):focus-visible`）——
         *      鼠标点进来不描圈、键盘进来照全局环。
         */
        if (hit.selector.includes(":focus-visible")) continue;
        if (hit.selector.includes('html:not([data-kb="1"])')) continue;
        offenders.push(`${name}:${hit.line}  ${hit.selector}`);
      }
    }
    expect(
      offenders,
      "这些控件又把全局 :focus-visible 焦点环压掉了 —— 键盘用户 Tab 进去看不到任何提示（P252）",
    ).toEqual([]);
  });

  it("⭐ 分档规则里必须列着那些控件（漏一个 = 那个控件的焦点环被压掉且没人管）", () => {
    const theme = bare(readCss("theme.css"));
    const block = theme.slice(theme.indexOf('html:not([data-kb="1"])'));
    for (const sel of [
      ".wb-agent-desc",
      ".wb-coding-search input",
      ".wb-coding-tools select",
      ".wb-imageaction-ask input",
      ".wb-threads-rename",
      ".wb-doc-title",
      ".wb-doc-body",
      ".wb-reader-input",
      ".wb-reader-search",
      ".wb-memory-add input",
      ".wb-model-search input",
      ".wb-set-search input",
      ".wb-nav-assign",
      ".wb-nav-input",
      ".wb-float-input",
    ]) {
      expect(block.slice(0, 1200), `${sel} 不在分档名单里`).toContain(sel);
    }
  });

  it("全局焦点环还在（这条不能被顺手删掉）", () => {
    const theme = bare(readCss("theme.css"));
    expect(theme).toMatch(/^:focus-visible\s*\{[^}]*var\(--focus-ring\)/m);
  });
});

describe("P257：只按 :hover 显形的按钮，键盘也要给显形", () => {
  it("⭐ 历史对话行的「⋯」：`:hover` 与键盘两条都在", () => {
    const panels = bare(readCss("panels.css"));
    /* ⚠️ 锚在**带子元素**的那条显形规则上：`.wb-threads-rowwrap:hover` 自己还有一条改底色的规则 */
    const at = panels.indexOf(".wb-threads-rowwrap:hover .wb-threads-rowmore");
    expect(at, "显形规则不见了").toBeGreaterThan(-1);
    const reveal = panels.slice(at, panels.indexOf("}", at));
    expect(reveal, "只有 :hover 一条 —— Tab 聚焦到隐形按钮上，屏幕上什么都没有").toMatch(
      /:focus-within|:focus-visible/,
    );
  });

  it("这条判据不是空转：它确实盯的是那个 `opacity: 0` 的按钮", () => {
    const block = ruleBlock(bare(readCss("panels.css")), ".wb-threads-rowmore {");
    expect(declOf(block, "opacity"), "`.wb-threads-rowmore` 不再靠 opacity 藏了 —— 这条守卫该跟着改").toBe("0");
  });
});

describe("P73：图层面板与版本历史面板不许叠在一起", () => {
  it("⭐ 两个面板的水平占位不许重叠（重叠 = 后开的把先开的整块盖住）", () => {
    const css = bare(readCss("canvas-nodes.css"));
    const layer = ruleBlock(css, ".layer-panel {");
    const versions = ruleBlock(css, ".versions-panel {");
    expect(layer, "找不到 .layer-panel 规则").not.toBe("");
    expect(versions, "找不到 .versions-panel 规则").not.toBe("");
    const num = (block: string, prop: string): number => {
      const raw = declOf(block, prop);
      expect(raw, `${prop} 没写（这个判定要靠它算占位）`).toBeTruthy();
      const parsed = Number(String(raw).replace("px", "").trim());
      expect(Number.isFinite(parsed), `${prop} 不是像素值：${raw}`).toBe(true);
      return parsed;
    };
    /* 两条都贴在右边：占位是 [right, right + width]（从右往左量） */
    const layerRight = num(layer, "right");
    const layerWidth = num(layer, "width");
    const versionsRight = num(versions, "right");
    /*
     * ⚠️ 判据必须盯**重叠**，不能只比"矩形相不相等"：两个面板宽度本来就不同
     *（250 / 268），只比 `right` 的话它们在修复前也"不相等"—— 那样的守卫盯不住 P73。
     */
    expect(
      versionsRight,
      `版本历史（right:${versionsRight}）与图层（right:${layerRight} + width:${layerWidth}）重叠了 ` +
        "—— 后开的会把先开的整块盖住，用户看到的是「点了版本历史，图层不见了」",
    ).toBeGreaterThanOrEqual(layerRight + layerWidth);
  });

  it("行为侧另有一条：两个开关互斥（见 canvasWiring 守卫）", () => {
    const runtime = bare(readFileSync(path.join(ROOT, "src/canvas/CanvasRuntime.tsx"), "utf8"));
    expect(runtime).toContain("setLayersOpen(false)");
    expect(runtime).toContain("setVersionsOpen(false)");
  });
});

describe("P75：导出时要藏起来的浮层清单", () => {
  it("⭐ 四个漏掉的浮层都补进那条规则了", () => {
    const css = readCss("canvas-nodes.css");
    const rule = css.slice(css.indexOf('[data-exporting="true"]'));
    const block = rule.slice(0, rule.indexOf("}"));
    for (const sel of [".text-toolbar", ".gen-panel", ".image-actions", ".bottom-toolbar"]) {
      expect(block, `${sel} 没在导出隐藏清单里 —— 导出的 PNG 上会带着它`).toContain(sel);
    }
  });
});

describe("P67 / K03 / P64：两段死 CSS 已删，不许长回来", () => {
  it("⭐ 样式里不再有 `.wb-canvas-toggle` / `.wb-canvas-chat-toggle` 的类规则", () => {
    for (const { name, text } of allCss()) {
      const css = bare(text);
      expect(
        /\.wb-canvas-chat-toggle\s*[,{]/.test(css) || /\.wb-canvas-toggle\s*[,{]/.test(css),
        `${name} 里又出现这两个死类了 —— 元素早就不存在（画布对话侧栏与右下角浮标都拆了），` +
          "留着只会让下一轮主题体检拿那 6 处硬编码浅色逐条解释",
      ).toBe(false);
    }
  });

  it("元素确实不存在（判据的另一半：不是「删了 CSS 却还有界面元素挂着」）", () => {
    const sources = readdirSync(path.join(ROOT, "src", "workbench"))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => readFileSync(path.join(ROOT, "src", "workbench", f), "utf8"))
      .join("\n");
    expect(/className="[^"]*wb-canvas-chat-toggle/.test(sources)).toBe(false);
    expect(/className="[^"]*wb-canvas-toggle/.test(sources)).toBe(false);
    /* 那颗「创建画布」还在，但用的是 testid（harness 认的是它）—— 别把它一起删了 */
    expect(sources, "技能面板那颗「创建画布」的 testid 没了 —— 验收脚本会找不到入口").toContain(
      'data-testid={c.isCanvas ? "wb-canvas-toggle"',
    );
  });
});
