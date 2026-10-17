import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C2 结构守卫：**事件流只许有一份解析**。
 *
 * ## 为什么这条必须存在
 *
 * "主进程发事件 → 渲染层解析成正文/留痕/用量"这段逻辑原来被写了**四遍**
 * （工作台 `store.ts`、悬浮助手 `FloatingAssistant.tsx`、
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
  "src/workbench/taskRuntime.ts", // C6-4：工作台那处折叠随运行时搬去了 taskRuntime.ts
  "src/workbench/FloatingAssistant.tsx",
  // 子智能体：它 fold 出**自己的报告**（正文/调过哪些工具/哪些被拦下）。
  // 这正是 C2-3 把"手写三个累加变量"换成同一份投影的那一步 —— 见它的文件头。
  "engine/runtime/subagent.ts",
]);

/**
 * 允许出现 `toolCallId: <x>.toolCallId` 的地方（两处，理由各不相同）。
 *
 * 上面那条判据（"不许手搓留痕"）防的是"有人自己造一条 ToolTrace 拿去显示"。
 * 这一条正则只能看出"有个对象的 toolCallId 取自另一个对象"，所以下面两处会误报 ——
 * 而它们都**不是**第二份投影：
 *
 * - `engine/runtime/loop.ts`：**事件的产出方**。它把 SDK 的 `part` 翻成事件
 *   （`onEvent({ type: "tool-call", toolCallId: part.toolCallId, … })`），那是投影的**上游**。
 * - `engine/runtime/subagent.ts`：把投影出来的留痕**收窄**成上报形状
 *   （`SubagentBlocked`：只要 id/名字/参数，因为父级要拿它就地放行）。
 *   它是投影的**下游消费者**，不是另一份解析。
 * - `engine/core/gates.ts`：把留痕**收窄**成待办形状（`GateRequest`）——
 *   同样是下游消费者（"现在有哪些待办"），不是自己重新折叠事件流。
 *
 * 把这两处一起骂，守卫就会逼人把翻译写得很绕 —— 而最后被删掉的往往是守卫。
 */
const TOOLCALL_ID_OK = new Set([
  "engine/runtime/loop.ts",
  "engine/runtime/subagent.ts",
  "engine/core/gates.ts",
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

/**
 * 在源码里找"手搓留痕 / 自己判待确认"的痕迹。
 *
 * ⚠️ 2026-10-16（审计 G25 扩面之后的三处误报，逐条收窄）：
 *   · `approvalRecord({ toolCallId: … })` 是**官方形状**（`engine/core/gates.ts`），
 *     不是"手搓" —— 只有**同时**出现 `toolCallId` 与 `name`/`ok`/`line` 才算一个自造 trace；
 *   · `t.pending === true`（读**投影**里已有的字段，做个归一化）不该报 ——
 *     要报的是从**裸 output** 里自己判：`output…pending`；
 *   · 宿主的**线上翻译层**（把一条事件翻成 ACP/CLI 的对外形状）确实要看单条事件的
 *     `output.pending`：那是协议要求，不是第二份解析。这类按文件白名单放行（见下），
 *     白名单里的每一处都要写清理由。
 */
function secondParserMarks(src: string): string[] {
  const marks: string[] = [];
  const code = stripComments(src);
  /* 自造 trace：一个对象字面量里同时有 toolCallId 与 line/ok/name（跨行也算） */
  if (/\{[^{}]{0,200}\btoolCallId:\s*\w+\.toolCallId[^{}]{0,200}\b(?:ok|line):/.test(code)) {
    marks.push("手搓 ToolTrace（toolCallId: …）");
  }
  if (/output as \{\s*pending|output[^;\n]{0,24}\.pending/.test(code)) marks.push("自己从 output 里判 pending");
  return marks;
}

/**
 * 放行的宿主翻译层（把**一条事件**翻成对外协议形状的地方）。
 *
 * ⚠️ 它们读 `output.pending` 是协议要求（ACP 要把"闸门拦下"报成 failed、
 * CLI 要把待确认标出来），不是"第二份投影"。产品层（`src/` / `engine/` /
 * `shared/`）**不在此列** —— 那里必须走 `engine/core/events.ts` 的投影。
 */
const HOST_TRANSLATORS = [
  "hosts/acp/agent.ts",
  /*
   * `hosts/server/approvalApi.ts`（V5 收尾加）：它把**审批索引的一行**翻成 HTTP 的视图
   * （`{sessionId, toolCallId, name, approvers, state, youCanDecide}`）。
   * 那是"对外协议形状"，不是第二份投影 —— 待决与"谁能批"是从 `approvals` 索引
   * 与 `gates.approversFor` 读来的（两处都只有一份实现）。
   * 守卫的正则把 `toolCallId: row.toolCallId` + `name:` 认成了"手搓 ToolTrace"：
   * 形状像，但它**不是**从事件流里自己算留痕 —— 理由写在这里，放行。
   */
  "hosts/server/approvalApi.ts",
];

describe("C2 结构守卫：事件流只有一份解析", () => {
  /*
   * ⚠️ 2026-10-16（审计 G25）：扫描面原来只有 src / shared / engine ——
   * 而**主进程（`electron/`）与两个新宿主（`hosts/`）**里同样会"手搓留痕 /
   * 自己判待确认"，那正是这条守卫要挡的东西（事件流只有一份解析）。
   * 漏掉它们 = 守卫在最重要的两个调用方上不设防。
   */
  const files = sources(path.join(ROOT, "src"))
    .concat(sources(path.join(ROOT, "shared")))
    .concat(sources(path.join(ROOT, "engine")))
    .concat(sources(path.join(ROOT, "electron")))
    .concat(sources(path.join(ROOT, "hosts")));

  it("判定本身有效（注释不误报、真痕迹必须抓到）", () => {
    expect(secondParserMarks("// 以前这里写 toolCallId: event.toolCallId")).toEqual([]);
    expect(secondParserMarks("/* toolCallId: event.toolCallId */")).toEqual([]);
    /* 自造 trace：同一对象字面量里 toolCallId + ok/line（`approvalRecord({...})` 的官方形状不算） */
    expect(secondParserMarks("const t = { toolCallId: event.toolCallId, ok: true, line: 'x' };")).toHaveLength(1);
    expect(secondParserMarks("approvalRecord({ toolCallId: request.toolCallId, name: request.name, line });")).toEqual([]);
    /* 从**裸 output** 里判 pending 要抓；读**投影**里已有的字段不抓 */
    expect(secondParserMarks("const p = (output as { pending?: boolean })?.pending;")).toHaveLength(1);
    expect(secondParserMarks("if (event.output.pending) return;")).toHaveLength(1);
    expect(secondParserMarks("if (t.pending === true) return;")).toEqual([]);
  });

  it("src/ 与 shared/ 里没有第二份解析（留痕与 pending 只能来自投影）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      // 见上面 SHAPE_OWNERS / TOOLCALL_ID_OK 的理由
      // 见上面 SHAPE_OWNERS / TOOLCALL_ID_OK / HOST_TRANSLATORS 的理由
      if (SHAPE_OWNERS.has(rel) || TOOLCALL_ID_OK.has(rel) || HOST_TRANSLATORS.includes(rel)) continue;
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
