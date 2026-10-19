import path from "node:path";

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

/** 计划文件：`.ding/plans/<sessionId>.md`（sessionId 只留安全字符）。 */
export function planFilePath(dataDir: string, sessionId: string): string {
  const safe = String(sessionId ?? "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, "-") || "session";
  return path.join(dataDir, ".ding", "plans", `${safe}.md`);
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
