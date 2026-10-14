import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C6-5 结构守卫：**巨石文件不许再长出来**。
 *
 * ## 为什么这条必须有
 *
 * C6 之前：`styles.css` 6015 行、`Workbench.tsx` 2188 行、`pages.tsx` 1669 行、`store.ts` 1253 行。
 * 它们**不是"不优雅"**，是三种具体代价（见 `docs/PLAN-C6-结构拆分.md`）：
 * 改一处要读两千行（于是"顺手加一行"变成默认做法）、重渲染没有边界、以及
 * **结构会自己退化** —— C2 之前"主循环被写四遍"就是同一个机理：文件够大，多写一份没人发现。
 *
 * 拆完之后要有东西看着，否则下一个人还会把它们长回去。这条就是那个"看着"。
 *
 * ## 阈值与例外
 *
 * - `.ts/.tsx` ≤ **900** 行、`.css` ≤ **1500** 行（拆分后的实测：最大 ts 是 `store.ts`，
 *   最大 css 是 `canvas-nodes.css` 1483）。
 * - **例外必须明牌**（`EXEMPT`），并且有一条断言盯着"例外不许空转"：
 *   `store.ts` 真的拆分之后，这条断言会红，逼你把它从名单里删掉。
 * - 改阈值是可以的，但**要在同一次改动里改这条测试并写明理由** ——
 *   与 `buildGate.test.ts` 那条规矩一致：**一道会悄悄消失的检查等于没有**。
 */

const ROOT = path.resolve(__dirname, "..");
const LIMIT = { code: 900, css: 1500 };

/**
 * 明牌例外（相对仓库根，正斜杠）。
 *
 * ⚠️ **现在是空的**：C6-4 把 `store.ts`（1296 行）拆成
 * `store.ts` + `taskRuntime.ts` + `taskPersist.ts` + `task.ts` 之后，它已降到 900 行以下。
 *
 * 这里原来挂着一条 `src/workbench/store.ts`，理由是"运行时状态机刻意留在一起，
 * 拆它要连测试一起重新设计，属行为级改动"。C6-4 证明那个判断不对：整块运行时**搬得走** ——
 * 靠 `StorePort` 把 store 的读写当参数注入，逻辑一个字不改
 * （见 `src/workbench/taskRuntime.ts` 的文件头与 `docs/PLAN-C6-4-拆store.md`）。
 *
 * 空集合是**有意的**：这个仓库现在没有需要豁免的巨石文件。
 * 真要再加，必须写明理由 —— 并且下面那条"例外必须真超阈值"的断言会盯着。
 */
const EXEMPT = new Set<string>();

/** 递归收集要检查的源文件。 */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 一个文件的行数与阈值。 */
function check(full: string): { rel: string; lines: number; limit: number; over: boolean } {
  const rel = path.relative(ROOT, full).replace(/\\/g, "/");
  const lines = readFileSync(full, "utf8").split("\n").length;
  const limit = rel.endsWith(".css") ? LIMIT.css : LIMIT.code;
  return { rel, lines, limit, over: lines > limit };
}

describe("C6-5：巨石文件守卫", () => {
  const files = sources(path.join(ROOT, "src"))
    .concat(sources(path.join(ROOT, "shared")))
    .concat(sources(path.join(ROOT, "engine")));

  it("判定本身有效（超一行就该判红，例外的文件也要真超）", () => {
    const sample = { rel: "x.ts", lines: LIMIT.code + 1, limit: LIMIT.code };
    expect(sample.lines > sample.limit).toBe(true);
    // 例外名单不许空转：里面的文件**必须真的超阈值**
    for (const rel of EXEMPT) {
      const full = path.join(ROOT, rel);
      const got = check(full);
      expect(
        got.over,
        `${rel} 已经不到 ${got.limit} 行了 —— 请把它从 EXEMPT 里删掉（例外名单不许空转）`,
      ).toBe(true);
    }
  });

  it(`没有文件超过上限（.ts/.tsx ≤ ${LIMIT.code}、.css ≤ ${LIMIT.css}；例外见 EXEMPT）`, () => {
    const offenders = files
      .map(check)
      .filter((r) => r.over && !EXEMPT.has(r.rel))
      .map((r) => `${r.rel}（${r.lines} 行 > ${r.limit}）`);
    expect(
      offenders,
      `这些文件又长回巨石了 —— 请按区域/组件把它拆开：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("扫描范围不是空的（守卫别成了空扫描）", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("重点目录真被扫到了（拆过的文件一个都不能漏）", () => {
    const rels = new Set(files.map((f) => path.relative(ROOT, f).replace(/\\/g, "/")));
    for (const must of [
      "src/workbench/Workbench.tsx",
      "src/workbench/store.ts",
      "src/styles.css",
      "src/styles/canvas-nodes.css",
      "src/canvas/CanvasRuntime.tsx",
      "engine/core/events.ts",
    ]) {
      expect(rels.has(must), `守卫没扫到 ${must}`).toBe(true);
    }
  });
});
