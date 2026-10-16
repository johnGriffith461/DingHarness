import { readdirSync, readFileSync } from "node:fs";
import path, { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 机械约束：**消息操作栏的每个动作都必须接了 onClick**。
 *
 * ## 这是 §36 那个 bug 的形状
 * 六个图标（复制 / 朗读 / 有帮助 / 没帮助 / 分享 / 重新生成）里，
 * **只有「复制」是活的**，其余五个点了没反应。
 *
 * 那比不放这些图标更糟：用户会以为功能坏了，或者以为自己点错了地方。
 * 而它的失效方式很隐蔽 —— **不报错、界面看起来完全正常**，
 * 只有真去点那五个才会发现。
 *
 * ## 为什么用测试钉
 * 「一排按钮里漏接一个」这种事，人眼扫代码很容易漏（那一排长得都一样）。
 * 前几轮我修过好几处同类（§34 插件「管理」、§45 设置五行），
 * 每次都是**逐个发现的**，而不是一次看全。
 *
 * 所以规则是：**`wb-actions` 里出现的每个 `<button>`，必须带 `onClick`。**
 */

/*
 * ⚠️ C6-1 把消息操作栏从 `Workbench.tsx` 拆成了 `MessageActions.tsx`。
 * 这条守卫是"**扫源码**"型的 —— 它盯的是"那段代码在哪个文件里"，
 * 所以拆分会让它失准。**这正是它的价值**：它逼你确认"新位置还在、约束还成立"，
 * 而不是让约束随着搬家悄悄失效。
 */
const FILE = join("src", "workbench", "MessageActions.tsx");
/** 仓库根（全仓扫描那条用）。 */
const ROOT = path.resolve(__dirname, "../..");

/**
 * 切出 `MessageActions` 那个函数的函数体。
 *
 * @param text 源码
 * @returns 函数体；找不到返回 null
 */
function messageActionsBody(text: string): string | null {
  const start = text.indexOf("function MessageActions(");
  if (start === -1) return null;
  // 函数体的结束：下一个顶层 `function ` 或 `/**` 之前
  const rest = text.slice(start);
  const nextFn = rest.indexOf("\nfunction ", 1);
  return nextFn === -1 ? rest : rest.slice(0, nextFn);
}

/**
 * ⚠️ 2026-10-16（审计 G22）：原来这条只扫 `MessageActions.tsx` **一个文件** ——
 * 而"看着能点、其实没作用"的按钮在别处也有（审计同口径查出两处真死控件）。
 * 这里补一条**全仓**扫描：`<button>` 既没有 `onClick`、也没有 `disabled`、
 * 也没有展开属性（`{...props}`）时，它就是一个"点了没反应"的形状。
 *
 * 允许的例外只有两类（写在下面，免得下一个人猜）：
 *   · `type="submit"`（表单提交靠 form 的 onSubmit）；
 *   · `aria-hidden` / `tabIndex={-1}` 这类**明确不可交互**的装饰（它不该是 button）。
 */
describe("全仓：不许有「看着能点、其实没作用」的按钮（审计 G22）", () => {
  const offenders: string[] = [];
  /** 按「文件::按钮文案」认领用的键（行号会漂，见 KNOWN_DEAD 那段说明）。 */
  const offenderKeys: string[] = [];
  /**
   * 已知的一处（**不在这里改 UI**，登记在案只为了这条守卫还能抓新的）：
   *   · `PluginsPage.tsx` 分类行「更多 ▾」—— 2006-10-16 扫出来的（比主人那张 8 条清单多一条），
   *     等主人定夺（删 / 实现 / 标不做）。
   * 修完之后把对应项从这名单里删掉 —— 这张表只该变短。
   *
   * ⚠️ 2026-10-16 修：这张表原来按**行号**钉（`FloatingAssistant.tsx:273`）——
   * 而我当天改浮窗那两颗按钮（P79/P80）之后行号挪到了 300 多，**守卫立刻红了一条与它无关的**。
   * 行号是"会漂的坐标"：任何一次无关的编辑都能把这条钉子拔掉，而红的是别人。
   * 现在按「文件::按钮文案」认（文案才是那颗按钮稳定的身份）。
   *
   * ⚠️ 2026-10-17：浮窗「本地电脑」那条**已从表里删掉** —— 按 V5 开工前清尾 §2.4 的
   * 处置（用户裁定该功能不需要），那颗按钮**移除**了（主输入区同款早删，它是漏网的一颗）。
   */
  const KNOWN_DEAD = new Set([
    /* 那颗按钮里还有一个 `▾`（表达式/图标）—— 认领键取的是**去表达式之后的纯文本**，所以是「更多」 */
    "src/workbench/PluginsPage.tsx::更多",
  ]);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        const text = readFileSync(full, "utf8");
        /*
         * ⚠️ 标签扫描要**花括号/引号感知**：多行标签里的属性表达式里常有 `>` 或 `=>`
         * （`onClick={() => …}`、`disabled={n > 0}`）—— 用 `/<button[^>]*>/` 会在那里
         * 提前截断，把**有** onClick 的按钮误报成没接（第一版就这样误报了 ModelChip）。
         */
        for (const m of text.matchAll(/<button\b/g)) {
          let i = m.index + m[0].length;
          let depth = 0;
          let quote = "";
          for (; i < text.length; i += 1) {
            const ch = text[i]!;
            if (quote) {
              if (ch === quote) quote = "";
              continue;
            }
            if (ch === '"' || ch === "'" || ch === "`") {
              quote = ch;
              continue;
            }
            if (ch === "{") depth += 1;
            else if (ch === "}") depth -= 1;
            else if (ch === ">" && depth === 0) break;
          }
          const attrs = text.slice(m.index + m[0].length, i);
          if (/\bonClick=|\bdisabled\b|\{\.\.\.|type="submit"/.test(attrs)) continue;
          const line = text.slice(0, m.index).split("\n").length;
          const rel = path.relative(ROOT, full).split(path.sep).join("/");
          /*
           * 认领标记取按钮**内容**里的纯文本（去掉属性、内层标签与表达式）——
           * 行号会漂，文案不会：浮窗那颗自己就写着"本地电脑"，那才是它稳定的身份。
           * ⚠️ 别拿"开标签"那一段抽文本（第一版就是这么写的，抽出来是空的）——
           * 内容在闭合的 `>` 与 `</button>` 之间。
           */
          const closeAt = text.indexOf("</button>", i);
          const inner = text.slice(i + 1, closeAt > 0 ? closeAt : Math.min(text.length, i + 200));
          const tagText = inner
            .replace(/<[^>]*>/g, " ")
            .replace(/\{[^{}]*\}/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          offenders.push(`${rel}:${line}::${tagText}`);
          offenderKeys.push(`${rel}::${tagText}`);
        }
      }
    }
  };
  walk(path.join(ROOT, "src"));

  it("每一个 `<button>` 都有 onClick / disabled / 展开属性之一", () => {
    const missing = offenders.filter((_, i) => !KNOWN_DEAD.has(offenderKeys[i] ?? ""));
    expect(
      missing,
      ["这些按钮点了没反应（补 onClick，或明确 disabled / 改成不可交互的形状）：", missing.join("\n")].join("\n"),
    ).toEqual([]);
  });
});

describe("消息操作栏：每个动作都要能点", () => {
  it("**wb-actions 里的每个 button 都带 onClick**", () => {
    const body = messageActionsBody(readFileSync(FILE, "utf8"));
    expect(body, "找不到 MessageActions —— 这条测试就是假的").not.toBeNull();

    const source = body ?? "";
    const offenders: string[] = [];
    // 逐个切 button 标签
    const buttonRe = /<button\b([\s\S]*?)>/g;
    let match: RegExpExecArray | null;
    while ((match = buttonRe.exec(source)) !== null) {
      const attrs = match[1];
      if (!/\bonClick=/.test(attrs)) {
        const label = /title="([^"]*)"/.exec(attrs)?.[1] ?? attrs.trim().slice(0, 40);
        offenders.push(`未接 onClick 的动作：「${label}」`);
      }
    }

    expect(offenders, ["消息操作栏里有点了没反应的动作（§36 那个 bug 的形状）：", offenders.join("\n")].join("\n")).toEqual(
      [],
    );
  });

  it("这条约束确实作用在真实的动作栏上（不是空扫描）", () => {
    const body = messageActionsBody(readFileSync(FILE, "utf8")) ?? "";
    const buttons = [...body.matchAll(/<button\b/g)].length;
    // 实机是六个动作；少于 4 说明切错了范围，这条测试就没有意义
    expect(buttons).toBeGreaterThanOrEqual(4);
  });
});
