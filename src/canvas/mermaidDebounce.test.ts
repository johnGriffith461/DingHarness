import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 图表节点：**输入不许直接驱动渲染**（2026-10-16，审计 **P250**）。
 *
 * ## 钉住的是哪件事
 *
 * `MermaidNode.tsx` 的渲染 effect 原来直接吃输入态 `draft`。每敲一个字符就起一次
 * **完整的** `mermaid.render`（全量 parse + 建 SVG，主线程里没法 worker 化），
 * 而 cleanup 只置 `cancelled = true` —— **已排队的渲染不会被取消**，仍会跑完再丢弃。
 * 打 60 个字就是 60 次完整渲染排队，表现是"边打字边卡"。
 *
 * ## 为什么是"读源码"的守卫
 *
 * 这仓的单测跑在 `environment: "node"` 上（没有 DOM 测试环境），
 * 组件渲染行为测不了 —— 与 `canvasWiring.test.ts` / `uiCraft.test.ts` / `deadControls.test.ts`
 * 同一套办法：**钉住写法**（渲染必须吃"节流后的值"，而不是输入态）。
 *
 * ## 变异实证
 *
 * 把渲染 effect 的依赖从 `[rendered, id]` 改回 `[draft, id]`（即 P250 的旧写法）→ 前两条红。
 */

const SRC = readFileSync(path.resolve(__dirname, "nodes/MermaidNode.tsx"), "utf8");

/** 取出"含 `mermaid.render(` 的那个 effect"的依赖数组内容。 */
function renderEffectDeps(): string {
  const m = /mermaid\.render\([\s\S]*?\n {2}\}, \[([^\]]*)\]\);/.exec(SRC);
  expect(m, "解析不出渲染 effect 的依赖数组 —— 这条守卫的判据本身失效了").toBeTruthy();
  return m?.[1] ?? "";
}

describe("图表节点：渲染吃的是节流后的内容（P250）", () => {
  it("⭐ 渲染 effect 不许直接依赖输入态 draft", () => {
    const deps = renderEffectDeps();
    expect(deps, "渲染 effect 直接吃 draft —— 每敲一个键就是一次全量 mermaid.render").not.toContain("draft");
    expect(deps, "渲染 effect 应该吃「节流后的值」").toContain("rendered");
  });

  it("⭐ 节流真的存在：有常量、有定时器、且卸载/连续输入会清掉它", () => {
    expect(SRC, "没有节流间隔常量").toMatch(/RENDER_DEBOUNCE_MS\s*=\s*\d+/);
    expect(SRC, "没有 setTimeout 用于推迟渲染").toMatch(/setTimeout\(\(\)\s*=>\s*setRendered\(/);
    expect(SRC, "定时器没被清掉（连续输入/卸载会留下排队中的渲染）").toContain("clearTimeout(timer)");
  });

  it("节流值仍然从输入态来（别把它接成别的来源，否则边改边看就断了）", () => {
    // `setRendered(draft)` —— 节流的是"输入 → 渲染"这一跳，不是换个数据源
    expect(SRC).toMatch(/setRendered\(draft\)/);
  });
});
