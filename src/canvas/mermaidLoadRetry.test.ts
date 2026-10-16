import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 图表库加载失败**不许被永久缓存**（2026-10-16，审计 **P253**）。
 *
 * ## 钉住的是哪件事
 *
 * `loadMermaid()` 把初始化结果缓存在模块级 `mermaidReady` 上（合理：Mermaid 全局只能初始化一次）。
 * 但原来**失败也留在缓存里** —— 一旦 `import("mermaid")` 或 `initialize()` 抛错，
 * 那个 rejected Promise 就一直挂着，此后**每个**图表节点的 catch 都拿到同一条 rejection，
 * 界面显示成「语法错误」，直到重启应用才自愈。触发场景在打包产物里很现实：
 * 懒分块读取失败（离线首开、更新后旧 chunk 被删而进程还活着、杀软占着文件）。
 *
 * 两件事一起钉：
 *   ① 失败要**清掉缓存**（下一个节点再试一次 —— 自愈，而不是"永久结论"）；
 *   ② 失败要说清是**加载失败**，不许伪装成「语法有误」（用户改语法改到对也没用）。
 *
 * ## 为什么是"读源码"的守卫
 *
 * 本仓单测跑在 node 环境（无 DOM），组件行为测不了；而且这里要守的正是
 * "那个模块级缓存有没有被清"这种**写法**——与 `canvasWiring.test.ts` 同一套办法。
 *
 * ## 变异实证
 *
 * 把 `.catch(...)` 里的 `mermaidReady = null;` 删掉（即 P253 的旧写法）→ 前两条红。
 */

const SRC = readFileSync(path.resolve(__dirname, "nodes/MermaidNode.tsx"), "utf8");

describe("图表库加载失败要能重试、且不被说成语法错误（P253）", () => {
  it("⭐ 失败路径必须清掉那个模块级缓存（否则一次失败＝这个会话里永久失败）", () => {
    const at = SRC.indexOf("mermaidReady = import(");
    expect(at, "找不到 loadMermaid 的初始化处 —— 判据失效了").toBeGreaterThan(-1);
    const tail = SRC.slice(at);
    const catchAt = tail.indexOf(".catch(");
    expect(catchAt, "loadMermaid 没有 catch 分支（失败会原样抛给调用方且缓存不清）").toBeGreaterThan(-1);
    const catchBody = tail.slice(catchAt, tail.indexOf("}", catchAt));
    expect(catchBody, "失败时没有把 mermaidReady 置回 null —— rejected 结果被永久缓存").toContain(
      "mermaidReady = null",
    );
  });

  it("⭐ 加载失败与语法错误要分得开（不许把加载失败说成「语法错误」）", () => {
    expect(SRC, "没有区分加载失败的标记类型").toMatch(/class\s+MermaidLoadError\s+extends\s+Error/);
    expect(SRC, "catch 里没有按「是不是加载失败」分开给文案").toContain("e instanceof MermaidLoadError");
    expect(SRC, "节点上没有 loadFailed 状态（标签就分不出三态）").toContain("loadFailed");
    // 标签必须三态：正常 / 语法错误 / 库未加载
    expect(SRC).toMatch(/tag=\{[^}]*loadFailed[^}]*\}/);
  });
});
