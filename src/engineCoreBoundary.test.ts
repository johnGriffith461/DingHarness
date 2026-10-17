import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **最小嵌入面（`ding-engine-core`）的边界守卫**（V5-4 任务 4.1）。
 *
 * 4.1 要的是 Cline 式的分包：一个**事件 + 主循环**的最小面（无 IO，能嵌进别的程序、
 * 别的运行时），与一个带 store / 宿主绑定的完整面（`ding-engine`）。
 *
 * 这条守卫盯的就是那条边界 —— 而且**它不是文档，是 import 闭包**：
 * 从 `engine/index.ts`（`createEngine` 那个入口）出发把 import 图走一遍，
 * 闭包里出现 `node:*` / `electron` 就红。
 *
 * ## 为什么必须有它
 *
 * 分包的口子在 diff 里看不出来：谁在 `engine/core/` 里随手写一句
 * `import fs from "node:fs"`，代码照跑、测试全绿，而"最小面"就悄悄变成了
 * "只能跑在 Node 里"。等到真有人往浏览器/沙箱/别的宿主里嵌的时候才发现，
 * 那时闭包已经长得收不回来了。**边界要么是机器判的，要么不是边界。**
 *
 * ## 口径
 *
 * · 闭包 = 本地相对 import 的传递闭包（`import`/`export from`/动态 `import()`），
 *   **从包自己的公开面**（`packages/engine-core/src/index.ts`）出发；

 * · 外部依赖里**只禁 IO 与宿主**（`node:*`、`bun:*`、`electron`）：`ai` / `@ai-sdk/*` /
 *   `zod` 这些是同构的纯库，留在最小面里是对的（主循环就要用它们发请求）；
 * · 闭包只许落在 `engine/core`、`engine/runtime`、`engine/ports`、`shared` 与入口文件里 ——
 *   这一条挡的是"顺手 import 一个 `engine/adapters/` 里的东西"（那些都是 IO 适配器）。
 */

const ROOT = path.resolve(__dirname, "..");
/** 最小面的入口（包自己的公开面文件 —— 冻结清单与它同一份）。 */
const ENTRY = "packages/engine-core/src/index.ts";

/** 闭包里**不许**出现的外部模块。 */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^node:/, why: "Node 内置（IO/进程/路径）" },
  { pattern: /^bun:/, why: "Bun 内置" },
  { pattern: /^electron$/, why: "宿主运行时" },
  { pattern: /^(fs|path|os|child_process|url|net|http|tls|crypto)$/, why: "裸内置名（旧写法）" },
];

/** 闭包只许在这些目录里（加目录 = 有意识地扩大最小面，改动要能解释）。 */
const ALLOWED_PREFIXES = ["packages/engine-core/src/", "engine/index.ts", "engine/core/", "engine/runtime/", "engine/ports/", "shared/"];

/**
 * 闭包规模预算 —— 涨了要有人解释"这一层为什么也得进来"。
 *
 * ⚠️ 2026-10-18（U02）45 → 47：工具结果落盘增加了两个**纯逻辑**文件 ——
 * `engine/ports/spill.ts`（端口类型）与 `engine/runtime/spill.ts`（策略 + 回注文案）。
 * 它们没有 `node:*`、不读全局路径，所以留在最小面里是对的；
 * 真正的文件写法在 `engine/adapters/spillStore.ts`（**不在**闭包里，由宿主注入）。
 *
 * ⚠️ 2026-10-18（U01）47 → 48：`engine/core/runState.ts`（状态迁移 + 回放）。
 * 它同样是纯逻辑（不碰 IO），而且是主循环收尾时必须写的记录 —— 必须在最小面里。
 *
 * ⚠️ 2026-10-18（U03）48 → 50：`commandRisk.ts`（命令分词 + 风险规则）与
 * `permissionRules.ts`（规则评估 + glob）。权限判定必须在最小面里 ——
 * 它是**执行点**上的判定，宿主不应该各写一份。
 *
 * ⚠️ 2026-10-18（U08）50 → 51：`shared/review.ts`（审阅的线路形状）。
 * `shared/ipc.ts` 引了它（从 900 行上限里搬出去的），而 `ConfirmMode` 的
 * 类型链本来就会把 `shared/ipc.ts` 带进闭包 —— 纯类型文件，没有任何 IO。
 *
 * ⚠️ 2026-10-18（U09）51 → 52：`engine/core/unfinishedTools.ts`（"结果未知"留痕的
 * 形状构造）。它由 `events.ts` 在恢复路径里调用，是纯函数。
 *
 * ⚠️ 2026-10-18（G03）52 → 53：`engine/runtime/toolSearch.ts`（BM25 工具选择）。
 * 注入决策属于内核（"哪些工具下发给模型"），必须在最小面里。
 */
const CLOSURE_BUDGET = 53;

/** 一条 import 语句里的模块说明符（够这个代码库的写法用）。 */
const SPEC =
  /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** 相对说明符 → 真文件（解析不出来给 null，交给调用方当"本地但找不到"处理）。 */
function resolveFile(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

type ClosureEntry = { file: string; externals: Set<string> };

/** 从入口出发走一遍 import 闭包。 */
function closureOf(entry: string): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>();
  const stack = [path.resolve(ROOT, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    let source = "";
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const externals = new Set<string>();
    for (const match of source.matchAll(SPEC)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      const resolved = resolveFile(file, spec);
      if (resolved) stack.push(resolved);
      else if (!spec.startsWith(".")) externals.add(spec);
    }
    seen.set(file, externals);
  }
  return seen;
}

/** 相对仓根的路径（断言里打出来的那种，Windows 上也是 `/`）。 */
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join("/");

describe("engine-core 的最小嵌入面（V5-4 4.1）", () => {
  const closure: ReadonlyMap<string, Set<string>> = closureOf(ENTRY);
  const entries: ClosureEntry[] = [...closure].map(([file, externals]) => ({ file: rel(file), externals }));

  it("闭包里没有 IO / 宿主模块（`node:*` / `electron`）", () => {
    const offenders: string[] = [];
    for (const { file, externals } of entries) {
      for (const spec of externals) {
        const hit = FORBIDDEN.find((f) => f.pattern.test(spec));
        if (hit) offenders.push(`${file} → ${spec}（${hit.why}）`);
      }
    }
    expect(
      offenders,
      `最小嵌入面被 IO 拖进来了（要么把它端口化：宿主注入；要么它不属于 engine-core）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("闭包只落在允许的目录里（adapters / hosts 一律不许混进来）", () => {
    const outsiders = entries.map((e) => e.file).filter((file) => !ALLOWED_PREFIXES.some((p) => file === p || file.startsWith(p)));
    expect(outsiders, `这些文件在最小面之外：\n${outsiders.join("\n")}`).toEqual([]);
  });

  it("闭包规模在预算内（${CLOSURE_BUDGET} 个文件）", () => {
    expect(entries.length, `最小面涨到 ${entries.length} 个文件了 —— 新进来的要能解释`).toBeLessThanOrEqual(CLOSURE_BUDGET);
  });
});
