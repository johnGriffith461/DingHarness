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
    for (const sel of ['.wb-composer:focus-within', '.wb-searchbox:focus-within']) {
      const block = lastBlock(sel);
      expect(block, `${sel} 不见了（焦点反馈被删了？）`).not.toBe("");
      expect(block, `${sel} 又加上了发光`).not.toMatch(/box-shadow/);
    }
    /*
     * ⚠️ 真根因（第三次才找到）：文本输入框被**鼠标**点中时浏览器**也算它
     * `:focus-visible`** —— 所以"用 `:focus-visible` 区分鼠标/键盘"这条路对输入框无效
     * （`:has(:focus-visible)` 同样无效，我试过）。现在的判据是**输入模态**：
     * `<html data-kb="1">`（Tab/方向键置位，鼠标/触摸清掉）。
     * 下面两条钉住这件事：焦点反馈必须挂在 `html[data-kb="1"]` 之下，
     * 且不许再出现"裸 `:focus-within` 就描边"的写法。
     */
    for (const sel of [".wb-composer:focus-within", ".wb-searchbox:focus-within"]) {
      expect(lastBlock("html[data-kb=\"1\"] " + sel), `${sel} 没有挂在输入模态下（鼠标点进去会描边）`).not.toBe("");
    }
    expect(css, "又出现裸 `:focus-within` 描边了（鼠标点进去就会亮）").not.toMatch(
      /^\s*\.wb-(composer|searchbox):focus-within\s*\{/m,
    );
    /* 内层输入框不许再套第二圈：必须显式写掉 */
    expect(css, "输入区里的 textarea 没有取消第二圈焦点环").toContain(".wb-composer-input:focus-visible");
    /* 焦点环取值必须中性（rgba 的黑/白），不能用彩色 */
    const token = css.match(/--focus-ring:\s*([^;]+);/);
    expect(token, "没有 --focus-ring 令牌").not.toBeNull();
    expect(token![1], `焦点环颜色不是中性的：${token![1]}`).toMatch(/rgba\(\s*(16,\s*24,\s*40|255,\s*255,\s*255)/);
  });

  /*
   * ⑦ 图标必须来自图标库，不许用 Unicode 字形 / emoji 顶替（2026-10-14）。
   *
   * 依据 `~/.agents/skills/impeccable/reference/craft-floor.md`：
   *   > "Unicode glyphs or emoji standing in for an icon system. Icons are drawn,
   *   >  from a real library or authored SVG, in one consistent stroke and weight."
   *
   * 我们本来就是 lucide 一整套，却有 32 处菜单/设置行写着 `icon: "💬" / "★" / "◈"` 这种
   * 字符（几乎全是云盘右键菜单、设置弹窗、画布节点菜单这三处）—— 一屏里同时出现
   * 彩色 emoji 和单色线性图标，最像"半成品"的就是这里。这一轮全换成了 lucide 组件。
   *
   * 断的是**写法**（源码级，和这个文件里其它几条一样）：`icon: "…"` 这种字符串图标
   * 不许再出现 —— 换成 `icon: <X size={13} />`。
   */
  it("⑦ 菜单/行的图标走图标库，不许 emoji / Unicode 字形顶替", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          const text = readFileSync(full, "utf8");
          if (/icon:\s*"[^"]/.test(text)) offenders.push(path.relative(ROOT, full).split(path.sep).join("/"));
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders, "这些文件里还在用字符当图标（换成 lucide 组件）").toEqual([]);
  });

  /*
   * ⑧ 只有图标的按钮必须有可访问名（2026-10-14 补了 67 处）。
   *
   * 依据 `baseline-ui`（"MUST add an `aria-label` to icon-only buttons"）与
   * `better-accessibility`（"Icon-only buttons need a descriptive `aria-label`"）。
   * 我们原来**只挂了 `title`**：浏览器确实会拿 title 兜底当可访问名，
   * 但它同时还是"鼠标悬停提示"，两者职责不同 —— 而且全仓 `aria-label` 只有 2 处。
   *
   * 判定：按钮内**没有中文可见文字**、却含图标组件、又没有 aria-label → 报出来。
   */
  it("⑧ 图标按钮都有 `aria-label`", () => {
    const offenders: string[] = [];
    const cjk = /[一-龥]/;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          const text = readFileSync(full, "utf8");
          const re = /<button[^>]*>/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text))) {
            const tag = m[0];
            if (tag.includes("aria-label")) continue;
            const end = text.indexOf("</button>", m.index + tag.length);
            if (end < 0) continue;
            const body = text.slice(m.index + tag.length, end);
            /*
             * ⚠️ 判据要**可判定**：可见文字常常写在 JSX 表达式里（`{CODING_LABELS.preview}`），
             * 源码里没有中文字面量 —— 第一版就是这么误报的（把一堆"有文字的按钮"报成缺名字）。
             * 做法：先把标签属性里的 `{...}` 去掉，剩下的如果还有 `{`，就说明有**表达式内容**
             * （可能是可见文字）→ 判不了，跳过；否则剩下的只有标签 → 确定是纯图标按钮。
             */
            const stripped = body.replace(/[A-Za-z-]+=\{[^}]*\}/g, "");
            if (cjk.test(stripped)) continue;
            if (stripped.includes("{")) continue;
            if (!/<[A-Z][A-Za-z0-9]*/.test(stripped)) continue;
            const line = text.slice(0, m.index).split("\n").length;
            offenders.push(`${path.relative(ROOT, full).split(path.sep).join("/")}:${line}`);
          }
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders, "这些图标按钮没有可访问名（补 aria-label）").toEqual([]);
  });

  /*
   * ⑨ `var(--x)` 用了就必须有人定义它（2026-10-14）。
   *
   * 起因是**技能面板一直透明**：它的 `background: var(--surface)` 里的 `--surface`
   * **全仓没有定义** —— `var()` 落空 = 那条声明静默失效，面板就透过去了，
   * 字压在下面的推荐卡上，用户根本读不了（截图对比：`c34c674` 那版就是这样）。
   * 这类错**没有任何东西会报**：CSS 不报错、界面不崩、验收也不红
   * （`accept-chips` 当时只量了宽高，量不出"背景是透明的"）。
   *
   * 扫描一次发现 5 个：`--surface` / `--surface-sunken` / `--muted` / `--text`
   * （还有一个 `--markmap-` 是注释里的误报，判据里排掉）。
   *
   * ⚠️ 画布的变量由 `.wb-canvas` 自己声明（见 `canvasThemeVars`），所以**全文扫**即可；
   * 深浅主题各一份也算"定义过"，这里只要求"至少有一处定义"。
   */
  it("⑨ 样式里 `var(--x)` 用的每个变量都有人定义", () => {
    const used = new Map<string, Set<string>>();
    const defined = new Set<string>();
    const files = ["styles.css", ...readdirSync(STYLE_DIR).filter((f) => f.endsWith(".css")).map((f) => `styles/${f}`)];
    for (const f of files) {
      const text = readFileSync(path.join(ROOT, "src", f), "utf8");
      for (const m of text.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) {
        if (!used.has(m[1])) used.set(m[1], new Set());
        used.get(m[1])!.add(f);
      }
      for (const m of text.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)) defined.add(m[1]);
    }
    const missing = [...used.entries()]
      .filter(([name]) => !defined.has(name))
      /* 注释里提到的外部变量（如 markmap 自带的 `var(--markmap-*)`）不算 */
      .filter(([name]) => !name.startsWith("--markmap-"))
      .map(([name, where]) => `${name}（用在 ${[...where].join(" / ")}）`);
    expect(missing, "这些变量用了但没人定义 —— `var()` 落空会让那条声明静默失效").toEqual([]);
  });
});
