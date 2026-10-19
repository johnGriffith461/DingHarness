/**
 * Plan 模式（C1）。
 *
 * 语义照 OpenCode 的 plan agent / ZCode 的 EnterPlanMode：
 * **计划阶段只读**，写与命令工具不下发（不是拦）。模型看不到就不会去试，
 * 也就不会把「我先写一点」当成计划的一部分。
 *
 * 状态迁移写成表：非法迁移一律拒绝（例如 `idle → executing` 必须是
 * `idle → planning → awaiting_approval → executing`，跳步会让"计划"这一环形同虚设）。
 */

export type PlanState = "idle" | "planning" | "awaiting_approval" | "executing";

/** 计划模式下**允许下发**的工具（只读）。 */
export const PLAN_MODE_TOOLS = [
  "list_files",
  "list_dir",
  "search_files",
  "read_file",
  "list_agents",
  "knowledge_search",
] as const;

const TRANSITIONS: Record<PlanState, readonly PlanState[]> = {
  idle: ["planning"],
  planning: ["awaiting_approval", "idle"],
  awaiting_approval: ["executing", "planning", "idle"],
  executing: ["idle"],
};

export function isPlanTransitionAllowed(from: PlanState, to: PlanState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * 计划模式下真正下发的工具名 = `only`（若有）× `PLAN_MODE_TOOLS` 的交集。
 * 角色白名单只会让它更窄；**永远不会**因为 plan 而多出写工具。
 */
export function planToolNames(only?: readonly string[]): string[] {
  const allowed = PLAN_MODE_TOOLS as readonly string[];
  return only?.length ? only.filter((name) => allowed.includes(name)) : [...allowed];
}

/**
 * 计划文本上限（20 KiB）。
 *
 * 计划是给人审阅的短文档，不是代码库快照；超限只截断并如实告诉用户，
 * 不静默接受一份几 MB 的文本写进磁盘。
 */
export const PLAN_TEXT_LIMIT = 20 * 1024;

/** 写盘端口：由宿主注入（engine 不 import `node:fs`，最小面有守卫）。 */
export type PlanWriter = (path: string, text: string) => Promise<void>;

/** 五段计划的段名（与 `renderPlanPrompt` 的约定一致）。 */
export const PLAN_SECTIONS = ["目标", "范围", "步骤", "验证", "风险"] as const;

/** 超过上限就截断（返回截断后的文本与是否截断过）。 */
export function truncatePlan(text: string): { text: string; truncated: boolean } {
  const raw = String(text ?? "");
  if (raw.length <= PLAN_TEXT_LIMIT) return { text: raw, truncated: false };
  return { text: raw.slice(0, PLAN_TEXT_LIMIT), truncated: true };
}

/**
 * 检查计划缺哪几段。
 *
 * 宽松匹配：段名出现在行首（可带 `1.`、`一、`、`##` 等前缀）才算 ——
 * 正文里顺口提到"风险"不该被当成有「风险」这一段。
 */
export function missingPlanSections(text: string): string[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const present = new Set<string>();
  for (const line of lines) {
    const head = line
      .replace(/^\s*(?:#{1,6}\s*)?(?:\d+[.、)]|[一二三四五六七八九十]+[、.)])\s*/, "")
      .trim();
    for (const section of PLAN_SECTIONS) {
      if (head.startsWith(section)) present.add(section);
    }
  }
  return PLAN_SECTIONS.filter((section) => !present.has(section));
}

/** 计划文件：`.ding/plans/<sessionId>.md`（sessionId 只留安全字符）。 */
export function planFilePath(dataDir: string, sessionId: string): string {
  const safe = String(sessionId ?? "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, "-") || "session";
  /*
   * 这里**不用 `node:path`**：`engine-core` 的最小面不许 import Node 内置（有守卫）。
   * 正斜杠在所有平台都能被 Node 的文件 API 接受，所以拼字符串是安全的。
   */
  const base = String(dataDir ?? "").split("\\").join("/").replace(/\/+$/, "");
  return `${base}/.ding/plans/${safe}.md`;
}

/**
 * 把批准后的计划写进 `.ding/plans/<sessionId>.md`。
 *
 * 写盘是本文件唯一的 IO —— 由宿主注入 `write`（桌面注入 `fs.writeFile`，
 * 单测注入内存实现）。失败不抛：调用方要把"未落盘"显示在面板上，
 * 而不是让批准动作整个失败。
 */
export async function writePlanFile(
  dataDir: string,
  sessionId: string,
  text: string,
  write: PlanWriter,
): Promise<{ ok: true; path: string; truncated: boolean } | { ok: false; path: string; error: string; truncated: boolean }> {
  const path = planFilePath(dataDir, sessionId);
  const { text: body, truncated } = truncatePlan(text);
  if (!body.trim()) return { ok: false, path, error: "计划是空的，没有内容可写", truncated };
  try {
    await write(path, body);
    return { ok: true, path, truncated };
  } catch (error) {
    return {
      ok: false,
      path,
      error: error instanceof Error ? error.message : String(error),
      truncated,
    };
  }
}

/**
 * 已批准计划注入给模型的块。
 *
 * 每次执行轮都重新注入（而不是只发一次）：压缩会把早期消息摘掉，
 * 只靠历史里那一轮，模型会"忘了计划第 3 步"。
 */
export function renderApprovedPlan(text: string, path?: string): string {
  const body = String(text ?? "").trim();
  if (!body) return "";
  return [
    "",
    "<approved_plan>",
    "用户已经批准下面这份计划，现在进入执行阶段：请按步骤执行；每完成一步用工具留下可验证的结果。",
    ...(path ? [`计划文件：${path}`] : []),
    body,
    "</approved_plan>",
  ].join("\n");
}

/**
 * 批准的**唯一判据**（状态机 + 非空 + 五段齐全）。
 *
 * 放在引擎里是为了让按钮、动作体、测试用的是同一条规则 ——
 * UI 的 disabled 只是提示，真正拦人的是这里。
 *
 * @returns 不能批准的原因；`null` = 可以批准
 */
export function planApprovalError(planState: PlanState | undefined, text: string | undefined): string | null {
  const from = planState ?? "idle";
  if (!isPlanTransitionAllowed(from, "executing")) {
    return from === "executing" ? "计划已经在执行" : "还没有可批准的计划（先让模型给出计划）";
  }
  const body = String(text ?? "").trim();
  if (!body) return "计划是空的，没有内容可批准";
  const missing = missingPlanSections(body);
  if (missing.length) return `计划缺少：${missing.join("、")}（补全后再开始执行）`;
  return null;
}

/**
 * 计划模式的系统提示（拼在任务提示词之后）。
 *
 * 只说两件事：先探索、给可执行计划；**不要改文件**（工具面已经保证，
 * 但提示词里再说一次能让模型少浪费一轮去试）。
 */
export function renderPlanPrompt(goal: string): string {
  return [
    "",
    "<plan_mode>",
    "现在是**计划模式**：你可以读文件、搜代码、列目录，但**不能修改任何文件、不能执行命令**。",
    `目标：${goal.trim() || "（用户这一轮的要求）"}`,
    "请先调查，再给出一份可执行的计划，固定五段：",
    "1. 目标 —— 做完之后什么算完成；",
    "2. 范围 —— 要改哪些文件/目录，明确不碰什么；",
    "3. 步骤 —— 按顺序列出，每步一个可验证动作；",
    "4. 验证 —— 用什么命令或检查确认成功；",
    "5. 风险 —— 可能踩的坑与回滚方式。",
    "不要调用写文件/跑命令的工具（它们现在不可用）；给完计划就停下等用户确认。",
    "</plan_mode>",
  ].join("\n");
}
