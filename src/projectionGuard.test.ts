import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C2 结构守卫：**事件流只许有一份解析**。
 *
 * ## 为什么这条必须存在
 *
 * "主进程发事件 → 渲染层解析成正文/留痕/用量"这段逻辑原来被写了**四遍**
 * （工作台 `store.ts`、聊天 `chatStore.ts`、悬浮助手 `FloatingAssistant.tsx`、
 * 主进程构造事件那一处），而且**已经漂移过**：工作台漏接 `usage`（`done` 分支都没有）、
 * 聊天不展开子智能体上交的调用、两处各有一个 `Map` 自己配对工具参数。
 *
 * C2 把答案收成一份（`engine/core/events.ts` 的 `applyEvent`）。收完了**得有人看着** ——
 * 否则下一个人想加个"顺便显示一下工具参数"，最自然的做法就是在回调里再写一遍
 * `toolCallId: event.toolCallId`。那一步不会报错，只会让两个答案重新出现。
 *
 * ⚠️ Phase 1 内迁之后，投影住在 `engine/core/events.ts`（内核），所以这份守卫的扫描范围
 * 也扩到 `engine/` —— 守卫**只扫 src/ 与 shared/** 的话，迁完之后它就在空转了
 * （这正是 C6-3 拆样式文件时踩过的那个形状：检查还在跑，只是什么都查不到）。
 *
 * ## 判据（三条）
 *
 * 1. **不许手搓留痕**：`toolCallId: <什么>.toolCallId` —— 留痕只能来自投影。
 * 2. **不许自己判"待确认"**：`output as { pending` / `pending === true` ——
 *    判据只有 `engine/core/events.ts` 的 `isPendingOutput`（判错会让用户以为事做完了）。
 * 3. **折叠入口白名单**：`applyEvent(` 只许出现在这几个界面路径 + 投影自己那里。
 *
 * ⚠️ 与 C1 的 JSON 落盘守卫同一套写法：**先去掉注释再判**（说明文字里会提到这些词），
 * 并且守卫自己带自测 —— 判定抓不到样例、或守着一堆不存在的文件，它就已经在空转了。
 */

const ROOT = path.resolve(__dirname, "..");

/** 允许调用 `applyEvent` 的文件（相对仓库根，正斜杠）。 */
const FOLD_CALL_SITES = new Set([
  "engine/core/events.ts", // 定义 + fold/projectTurn 内部折叠
  "src/ai/chatStore.ts",
  "src/workbench/taskRuntime.ts", // C6-4：工作台那处折叠随运行时搬去了 taskRuntime.ts
  "src/workbench/FloatingAssistant.tsx",
]);

/**
 * 允许出现这些痕迹的地方，以及**为什么它们不是"第二份解析"**。
 *
 * - `engine/core/events.ts`：这就是那一份投影。
 * - `shared/agentTools.ts`：它定义**留痕的形状与文案**（`ToolTrace` 类型、
 *   `describeToolResult` 生成那一行、`blockedToTraces` 造待批准项、
 *   `normalizeToolTraces` 恢复落盘数据）。投影是**调用**它们，不是与它们并列 ——
 *   它不折叠事件流，所以不属于要防的那件事。
 *   （把这里删掉会让守卫连"唯一那份实现"一起骂，那它就废了。）
 */
const SHAPE_OWNERS = new Set(["engine/core/events.ts", "shared/agentTools.ts"]);

/** 去掉块注释与整行注释（判定前必须先做：说明文字里就会提到这些词）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 递归收集 .ts/.tsx（跳过 node_modules 与测试文件）。 */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** 在源码里找"手搓留痕/自己判待确认"的痕迹。 */
function secondParserMarks(src: string): string[] {
  const marks: string[] = [];
  const code = stripComments(src);
  if (/\btoolCallId:\s*\w+\.toolCallId/.test(code)) marks.push("手搓 ToolTrace（toolCallId: …）");
  if (/output as \{\s*pending/.test(code)) marks.push("自己从 output 里判 pending");
  if (/\bpending === true/.test(code)) marks.push("自己比 pending === true");
  return marks;
}

describe("C2 结构守卫：事件流只有一份解析", () => {
  const files = sources(path.join(ROOT, "src"))
    .concat(sources(path.join(ROOT, "shared")))
    .concat(sources(path.join(ROOT, "engine")));

  it("判定本身有效（注释不误报、真痕迹必须抓到）", () => {
    expect(secondParserMarks("// 以前这里写 toolCallId: event.toolCallId")).toEqual([]);
    expect(secondParserMarks("/* toolCallId: event.toolCallId */")).toEqual([]);
    expect(secondParserMarks("const t = { toolCallId: event.toolCallId, name: 'x' };")).toHaveLength(1);
    expect(secondParserMarks("const p = (output as { pending?: boolean })?.pending;")).toHaveLength(1);
    expect(secondParserMarks("if (x.pending === true) return;")).toHaveLength(1);
  });

  it("src/ 与 shared/ 里没有第二份解析（留痕与 pending 只能来自投影）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      if (SHAPE_OWNERS.has(rel)) continue; // 见上面 SHAPE_OWNERS 的理由
      const marks = secondParserMarks(readFileSync(file, "utf8"));
      if (marks.length) offenders.push(`${rel} → ${marks.join("、")}`);
    }
    expect(
      offenders,
      `这些地方在自己解析事件流 —— 请改用 engine/core/events.ts 的投影：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("`applyEvent` 的调用点只在明列的界面路径里", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const code = stripComments(readFileSync(file, "utf8"));
      if (!/\bapplyEvent\s*\(/.test(code)) continue;
      if (!FOLD_CALL_SITES.has(rel)) offenders.push(rel);
    }
    expect(offenders, `这些文件直接调用了 applyEvent（要么走投影、要么把这里加进白名单并写明理由）：\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("白名单里的文件都还在，且真的在调 applyEvent（防止白名单变成空转）", () => {
    for (const rel of FOLD_CALL_SITES) {
      const full = path.join(ROOT, rel);
      const code = stripComments(readFileSync(full, "utf8"));
      expect(/\bapplyEvent\s*\(/.test(code), `${rel} 已不再调用 applyEvent，请从白名单里去掉`).toBe(true);
    }
  });

  it("守卫自己别成了空扫描", () => {
    expect(files.length).toBeGreaterThan(100);
  });
});
