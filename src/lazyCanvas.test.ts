import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 首屏不背画布（D06，2026-10-18）。
 *
 * 产品审计量到"桌面可操作 3540ms"，而 `@xyflow/react`（画布库 + 样式）原来在
 * `main.tsx` 里静态 import —— 用户打开应用、**根本没用画布**，也要先下载/执行它。
 *
 * 现在画布是一个动态 chunk：`Workbench` 只在 `canvasOpen` 时 `import()`。
 * 这条守卫挡的是"哪天有人顺手把 provider 加回 main"那种回归 ——
 * 它不会让任何功能测试变红，只会让启动悄悄变慢。
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** 递归收集 src 下的源码（跳过测试）。 */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉注释（判定用：注释里提到 `@xyflow` 不是问题）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 这一行是不是**运行时** import（`import type` 会被类型擦除，不拉 chunk）。 */
function runtimeXyflowImport(src: string): boolean {
  return /^\s*import\s+(?!type\b)[^;\n]*["']@xyflow/m.test(stripComments(src));
}

describe("画布懒加载（D06）", () => {
  it("⭐ 首屏入口不 import @xyflow/react（那是画布的库，不该为首屏付钱）", () => {
    expect(runtimeXyflowImport(read("src/main.tsx"))).toBe(false);
  });

  it("⭐ Workbench 用 lazy() 加载画布，而不是静态 import", () => {
    const code = read("src/workbench/Workbench.tsx");
    expect(code).toContain('lazy(() => import("@/canvas/CanvasRuntimeHost"))');
    expect(code).not.toMatch(/^import CanvasRuntime/m);
  });

  it("ReactFlowProvider 在懒加载边界内（不能回到 main.tsx）", () => {
    const host = read("src/canvas/CanvasRuntimeHost.tsx");
    expect(host).toContain("ReactFlowProvider");
    expect(host).toContain('from "./CanvasRuntime"');
  });

  it("画布的 CSS 也随 chunk 走（不是首屏全局样式里的一份）", () => {
    expect(read("src/canvas/CanvasRuntime.tsx")).toContain('@xyflow/react/dist/style.css');
  });

  it("只有 canvas/ 目录能**运行时** import @xyflow（`import type` 不算）", () => {
    const offenders: string[] = [];
    for (const file of collect(path.join(ROOT, "src"))) {
      const rel = path.relative(ROOT, file).replaceAll("\\", "/");
      if (rel.startsWith("src/canvas/")) continue;
      if (runtimeXyflowImport(read(rel))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
