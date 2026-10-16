import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { titlebarHeight } from "./FloatingAssistant";

/**
 * 悬浮助手窗口两条（2026-10-16 审计 P188 / P190）。
 *
 * ## P188 是什么
 *
 * 浮窗上边有一条下界（不许钻进自绘标题栏那一条，否则连它自己的标题栏都被盖住）。
 * 那条线的值原来是 TS 里写死的 `const FLOAT_MIN_Y = 36`，而标题栏高度**另有唯一定义处**
 * —— `shell.css:--win-titlebar-h`。两处各写一遍同一个数：把 CSS 改成 40 / 32 之后，
 * 浮窗又能钻进拖动区，而守卫（只读 CSS 的那条）看不见 TS 里的第二份。
 *
 * ## P190 是什么
 *
 * 浮窗那两处失败出口原来是 `` `（出错了）${error.message}` ``，
 * 上游原话（`ENOENT: …`、SDK 堆栈）直接落到用户眼前。现在一律过 `uiError`。
 *
 * ## 判据怎么取
 *
 * P188 是**行为**（改 CSS 变量的值 → 读出来的下界跟着改；读不到 → 兜底而**不是 NaN**，
 * NaN 会让 `Math.min/Math.max` 全废、浮窗直接拖不动）；P190 是**源码**（那两处出口必须走
 * `uiError`，不许再出现 `error.message`）—— 后者是刻意的：这类泄漏的形状就是
 * "某个新加的 catch 顺手把 message 贴上去了"，行为测不到它。
 */

/** 浮窗源码（去注释：注释里提到的旧写法不许把守卫自己骗了）。 */
function floatSource(): string {
  const text = readFileSync(path.resolve(__dirname, "FloatingAssistant.tsx"), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 临时给 node 环境塞一个 document / getComputedStyle（跑完必须还原）。 */
function withCssVar(value: string | undefined, run: () => void): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const hadDoc = "document" in g;
  const hadGcs = "getComputedStyle" in g;
  const beforeDoc = g.document;
  const beforeGcs = g.getComputedStyle;
  try {
    g.document = { documentElement: {} };
    g.getComputedStyle = () => ({ getPropertyValue: () => value ?? "" });
    run();
  } finally {
    if (hadDoc) g.document = beforeDoc;
    else delete g.document;
    if (hadGcs) g.getComputedStyle = beforeGcs;
    else delete g.getComputedStyle;
  }
}

describe("P188：浮窗的上界跟着 CSS 变量走（不是在 TS 里再抄一遍）", () => {
  it("⭐ 改 `--win-titlebar-h`，读出来的下界跟着改", () => {
    withCssVar("40px", () => expect(titlebarHeight()).toBe(40));
    withCssVar("32px", () => expect(titlebarHeight()).toBe(32));
  });

  it("⭐ 变量读不到（没定义 / 空串）→ 兜底 36，且必须是**有限的数**", () => {
    withCssVar("", () => {
      const got = titlebarHeight();
      expect(got).toBe(36);
      expect(Number.isFinite(got), "NaN 会让 Math.min/Math.max 全废 —— 浮窗直接拖不动").toBe(true);
    });
  });

  it("变量值不是数（写着 `12rem` 之类）→ 同样兜底", () => {
    withCssVar("12rem", () => expect(titlebarHeight()).toBe(36));
  });

  it("没有 DOM（单测的 node 环境就是）→ 兜底，不抛", () => {
    expect(titlebarHeight()).toBe(36);
  });

  it("源码守卫：TS 里不许再出现写死的 36 / FLOAT_MIN_Y 常量", () => {
    const src = floatSource();
    expect(/FLOAT_MIN_Y\b/.test(src), "又把它收成一个写死的常量了（改 CSS 就漂）").toBe(false);
    expect(src, "下界要来自 CSS 变量").toContain('getPropertyValue("--win-titlebar-h")');
    expect(src, "读不到要有兜底（空串 → NaN 会让浮窗拖不动）").toContain("FLOAT_MIN_Y_FALLBACK");
    /*
     * ⚠️ 上面三条只说明"文件里有这么个函数" —— 组件**没接上**它也照样绿（实测踩过：
     * 把 `useState(titlebarHeight)` 退回 `useState(() => 36)` 时它们无反应）。
     * 所以再钉两条：这个数在文件里**只许出现一次**（就是兜底常量那一行），
     * 以及组件真的从这个函数取值。
     */
    expect(src.match(/\b36\b/g)?.length ?? 0, "36 又写到第二处了 —— 那正是 P188 的形状").toBe(1);
    expect(src, "组件没从 `titlebarHeight()` 取值（守卫会变成空转）").toContain("useState(titlebarHeight)");
  });
});

describe("P190：浮窗的错误文案过一遍人话", () => {
  it("⭐ 两处失败出口都走 `uiError`，源码里不许再拼 `error.message`", () => {
    const src = floatSource();
    expect(src, "上游原话直接贴进气泡了（P190）").not.toContain("error.message");
    expect(src, "认不出来也不许把原文贴上界面 —— 走 `uiError`").toContain("uiError(");
    /* 两处：引擎发来的 error 事件 + catch 到的那一类 */
    expect(src.match(/uiError\(/g)?.length ?? 0, "两处失败出口都要过它").toBeGreaterThanOrEqual(2);
  });
});
