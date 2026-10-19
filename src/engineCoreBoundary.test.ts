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
 *
 * ⚠️ 2026-10-18（G04）53 → 54：`shared/browserTools.ts`（浏览器工具声明）。
 * 由 `shared/agentTools.ts` 引进闭包；纯 schema 与快照脚本，没有 IO。
 *
 * ⚠️ 2026-10-18（G05）54 → 56：`shared/uia.ts`（元素树形状与解析）与
 * `shared/uiaTools.ts`（三条工具声明）。同样是纯逻辑，由工具表带进闭包。
 *
 * ⚠️ 2026-10-18（G06–G08）56 → 59：`runtime/streamFrames.ts`（续传帧）、
 * `runtime/jobs.ts`（后台任务记录）、`runtime/skills.ts`（技能发现与预算）。
 * 三者都是纯逻辑（IO 由调用方注入路径），且属于运行协调层。
 *
 * ⚠️ 2026-10-18（L04）59 → 60：`runtime/pluginIndexTrust.ts`（索引钉摘要 + 验签）。
 * 摘要与验签是插件的信任地基，必须与 `pluginSignature.ts` 同一份；其余
 * `pluginDeps.ts` 不在闭包里（只被插件适配器引用）。
 *
 * ⚠️ 2026-10-18（L06）60 → 62：`shared/keymap.ts`（键位判定/校验）与
 * `shared/persona.ts`（人格偏好收窄与提示词片段）。两者都是**零 IO 的纯函数**，
 * 被 `shared/ipc.ts` 的契约类型带进来（主进程落盘与渲染层判定必须同一份）。
 *
 * ⚠️ 2026-10-18（G15）62 → 63：`shared/knowledgeWire.ts`（知识库的 IPC 形状）。
 * 纯类型 + 常量（允许的扩展名/大小上限），被 preload 与契约带进来。
 *
 * ⚠️ 2026-10-19（T0）63 → 69：模型能力表单的 6 个模块，**全部零 IO 的纯逻辑**：
 *   · `shared/modelConfigWire.ts` —— IPC 形状（纯类型，被 ipc.ts 带进来）；
 *   · `engine/runtime/modelConfig.ts` —— 稀疏覆盖 + 规则解析（无 IO）；
 *   · `engine/runtime/modelOptionMap.ts` —— 声明式映射 + RFC 7396（纯函数）；
 *   · `engine/runtime/modelRuntime.ts` —— 按协议造 provider 工具（只 import SDK）；
 *   · `engine/runtime/messageTransform.ts` —— 消息形态转换（纯函数）；
 *   · `engine/runtime/modelOptionMapFetch.ts` —— fetch 包装（只有类型级 fetch，不读环境）。
 * 它们必须在内核里：窗口预算、请求组装、参数映射都要和渲染层用同一份判定，
 * 抄第二份就会分叉（界面上填 1M、请求里还是 20k）。
 *
 * ⚠️ 2026-10-19（T0 第二轮）69 → 71：「新供应商」要支持第三种 API 格式
 * （OpenAI Responses，`/responses`）——它与 Chat Completions 是两条不同接口，
 * 不能当成同一个兼容。新增两个：
 *   · `engine/runtime/protocols/openaiResponses.ts` —— 适配器（只 import SDK）；
 *   · `shared/providerWire.ts` —— 供应商表单的 IPC 形状（纯类型）。
 * 前者必须在内核里（协议只许有一个装配点），后者被 ipc.ts 带进来。
 */
/**
 * 2026-10-19（C1/E1）71 → 73：`engine/runtime/planMode.ts`（计划模式的纯状态/工具表）
 * 与 `engine/runtime/verifyLoop.ts` 之一由入口引入；两者都不碰 IO，
 * 属于"内核自己要知道的规则"，留在最小面里是对的。
 *
 * 2026-10-19（P0-02/06）73 → 75：`engine/runtime/finishContract.ts`（完成契约：
 * 证据校验与 turn 账本）与 `engine/runtime/stall.ts`（重复调用检测）由主循环直接
 * import —— 它们是"一轮怎么收尾"的规则，必须和循环住一起；两者都不碰 IO。
 *
 * 2026-10-20（B-01）75 → 76：`engine/core/editGuard.ts`（接受编辑档的路径守卫）。
 * 它由 `policy.ts` import —— "哪些路径永远要问"必须在判定层里，不能放给宿主；
 * 纯字符串实现，**没有 `node:path`**（这条闭包禁 `node:*`，见那个文件头）。
 */
const CLOSURE_BUDGET = 76;

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
