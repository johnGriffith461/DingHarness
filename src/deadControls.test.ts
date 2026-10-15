import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 死控件守卫（2026-10-15，M0 工单 3）。
 *
 * ## 它挡的是什么
 *
 * 工单清出 26 处「`disabled` + 一句借口」的控件（"本机版还没做 / 暂未 / 未做 / 本机版没有"）。
 * 这类东西对用户来说**和坏掉没有区别**：看得见、点不动、悬停才知道为什么。
 * 工单给了三条出路 —— **实现 / 移除 / 降级为非交互元素** ——
 * 并且明确"不允许留下第四种 disabled + 借口"。这条守卫就是那句"不允许"的机器版。
 *
 * ⚠️ 判定前**必须去注释**：这些说明写进注释是**对的**（上面每处处置都留了理由），
 * 不去注释就会把"我写下的解释"当成违规 —— C1/C2 与 `uiCraft.test.ts ①` 都踩过这个坑。
 *
 * 行为侧由 `scripts/accept/` 那几个真点界面的脚本挡（`accept-accountmenu` 断言
 * "菜单里一项都不许置灰"、`accept-context` 断言右键菜单同理、`accept-threads` 断言
 * 那颗「批量操作」不该再出现）。**读源码挡写法，点界面挡行为**，缺一层都拦不住复发。
 */

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

/** 借口词：工单那份清单就是按这几个词 grep 出来的。 */
const EXCUSE = /还没|暂未|未做|本机版没有/;

/** 去掉 JSX 注释与行注释（只用于判定，不写回文件）。 */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** 递归收集 .tsx / .ts（跳过测试与依赖）。 */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      collect(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 找出「`disabled` 和借口词落在同一个 JSX 开始标签里」的位置。
 *
 * 取法：从 `disabled` 往后到第一个 `>`（属性区），以及往前到最近的 `<`（标签开头部分）——
 * 两段里任一含借口词就算。这样能覆盖两种写法：
 *   `<button disabled title="本机版还没做…">`（借口在后面）
 *   `<button title="本机版还没做…" disabled>`（借口在前面）
 */
function offenders(src: string): Array<{ line: number; snippet: string }> {
  const out: Array<{ line: number; snippet: string }> = [];
  const re = /disabled/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const tail = src.slice(m.index, m.index + 400);
    const cut = tail.indexOf(">");
    const attr = tail.slice(0, cut >= 0 && cut <= 400 ? cut : 400);
    const head = src.slice(Math.max(0, m.index - 300), m.index);
    const open = head.slice(head.lastIndexOf("<"));
    if (EXCUSE.test(attr) || EXCUSE.test(open)) {
      out.push({ line: src.slice(0, m.index).split("\n").length, snippet: attr.trim().slice(0, 90) });
    }
  }
  return out;
}

describe("死控件守卫（M0 工单 3：不许再长回「disabled + 借口」）", () => {
  const files = collect(SRC);

  it("① 全仓没有一处「disabled + 还没/暂未/未做/本机版没有」", () => {
    const hits: string[] = [];
    for (const full of files) {
      const src = stripComments(readFileSync(full, "utf8"));
      for (const o of offenders(src)) {
        hits.push(`${path.relative(ROOT, full).replace(/\\/g, "/")}:${o.line}  ${o.snippet}`);
      }
    }
    expect(
      hits,
      [
        "工单 3 的口径：`disabled` + 借口词是**不允许留下的形态**（用户眼里和坏掉没区别）。",
        "三条出路：实现 / 移除 / 降级为非交互元素（span + aria-hidden，或纯静态文案）。",
        "若这次确实是把它做出来了，那它就不该再 disabled。",
      ].join("\n"),
    ).toEqual([]);
  });

  it("② 左栏折叠只有一份实现，六个页面都用它", () => {
    /* 去注释再判：上面那段注释里就写着"原来六处都是 disabled" */
    const impl = stripComments(readFileSync(path.join(SRC, "workbench", "NavCollapseButton.tsx"), "utf8"));
    expect(impl, "收起按钮不许是禁用的 —— 它是本次实现的那条").not.toMatch(/disabled/);
    expect(impl).toMatch(/toggleNav/);
    expect(impl, "标题要跟着状态走（收起/展开是两件事）").toMatch(/collapsed \? "展开左侧栏" : "收起左侧栏"/);

    /*
     * 原来这颗按钮在**六个地方各写了一遍**（云盘 / 插件 / 定时任务 / 手机遥控 / 任务视图 /
     * 任务中心），六份都是 disabled。收成一个组件之后，谁再手写一份就是又把口径散了。
     */
    const handWritten: string[] = [];
    for (const full of files) {
      if (full.endsWith("NavCollapseButton.tsx")) continue;
      const src = stripComments(readFileSync(full, "utf8"));
      if (/aria-label="(打开\/收起左侧栏|收起侧栏)"/.test(src)) {
        handWritten.push(path.relative(ROOT, full).replace(/\\/g, "/"));
      }
    }
    expect(handWritten, "这些文件在手写左栏折叠按钮，应该用 NavCollapseButton").toEqual([]);
  });

  it("③ 左栏折叠的状态与几何都在（少了任一环，按钮就是摆设）", () => {
    const store = readFileSync(path.join(SRC, "workbench", "store.ts"), "utf8");
    expect(store).toMatch(/navCollapsed: boolean/);
    expect(store).toMatch(/toggleNav: \(\) => set/);

    const css = readFileSync(path.join(SRC, "styles", "workbench.css"), "utf8");
    expect(css, "没有收起的几何：按钮点了界面也不会变").toMatch(/\.wb-nav\.is-collapsed\s*\{/);
    expect(css).toMatch(/\.wb-nav\.is-collapsed\s*\{[^}]*flex:\s*0 0 0/);

    const nav = readFileSync(path.join(SRC, "workbench", "NavSidebar.tsx"), "utf8");
    expect(nav, "左栏没有挂上收起态").toMatch(/navCollapsed \? " is-collapsed" : ""/);
  });
});
