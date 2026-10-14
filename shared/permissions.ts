/**
 * 审批闸门的判定层（§143，优化计划批次 2）。
 *
 * ## 为什么要有这一层
 *
 * 输入区那个 chip（「全部允许 / 按需确认 / 每步确认」）**早就画在那里了**，
 * 但全文没有任何地方读它 —— 也就是说它是个**装饰**：标签在承诺一道闸，而闸不存在。
 *
 * 研究结论（`docs/research-B-permission-subagent.md`）给的形态很明确：
 * - 策略**按工具名**声明（Cline 的 `toolPolicies`）；
 * - **未声明的默认放行**，需要复核的必须显式收紧；
 * - 粒度是**每次工具调用**，不是全局开关；
 * - 关掉一个工具 = **让它从模型视野里消失**（`enabled:false`），
 *   而不是让模型反复调用然后被拒。
 *
 * ## 判定只有三种结果
 *
 * | 结果 | 含义 |
 * |---|---|
 * | `run` | 直接执行（今天的行为） |
 * | `ask` | **不执行**，把这次调用交给用户确认 |
 * | `hide` | 工具根本不注入给模型（它看不到，也就不会试） |
 */

/** 输入区那个 chip 的三个档位（文案照本体实机截图，§130）。 */
export const CONFIRM_MODES = ["全部允许", "按需确认", "每步确认"] as const;
export type ConfirmMode = (typeof CONFIRM_MODES)[number];

/** 工具的读写性质 —— 决定"按需确认"档要不要拦它。 */
export type ToolKind = "read" | "write";

export type ToolPolicy = {
  kind: ToolKind;
  /** `false` = 从注入列表里去掉（模型看不到）。省略即启用。 */
  enabled?: boolean;
};

/**
 * 策略表。
 *
 * **未列出的工具默认按 `read` 放行** —— 与 Cline 一致：需要复核的必须显式声明。
 * 这个默认是有意的：加新工具时"忘了声明"应当表现为**照常能用**，
 * 而不是"悄悄变成一个必须点确认的卡"（后者会让人以为产品坏了）。
 */
export const TOOL_POLICY: Record<string, ToolPolicy> = {
  memory_save: { kind: "write" },
  memory_list: { kind: "read" },
  /*
   * 定时任务是**会反复自己跑**的东西（写类）—— 放到"按需确认"档里必须问。
   * 顺手说明为什么"按需确认"这一档有意义：它拦的正是这类**有后续影响**的动作，
   * 而不是把只读查询也一起拦下（那样每次都点确认，闸很快就被人无视）。
   */
  schedule_create: { kind: "write" },
  schedule_list: { kind: "read" },
  // 往画布加节点也是写（会改用户的画布内容）
  canvas_add_node: { kind: "write" },
  /*
   * 派子智能体算**写**：它会花一次真实的模型调用（成本），而且能做一串动作。
   * 所以「按需确认」档下要问一次 —— 用户同意的是"花这笔钱去办这件事"。
   *
   * ⚠️ 注意这不替代子智能体内部的闸门：它自己那套工具**照样按同一个档位判**
   * （审批穿透）。两层是叠加的，不是二选一。
   */
  spawn_agent: { kind: "write" },
  /*
   * 读文件是**只读**：它不改用户的任何东西，只是把用户自己目录里的文本念给模型听。
   * 所以「按需确认」档下不拦（拦就变成"看一眼文件都要点一次确认"，闸很快会被无视）；
   * 「每步确认」档下当然还是问（那一档的定义就是无论读写都要问）。
   *
   * ⚠️ 显式写出来而不是靠"默认 read"：这条策略表**加工具时必须逐条声明**
   * （`permissions.test.ts` 盯着这件事）—— 默认放行是个便利，不是让人省掉声明的理由。
   */
  read_file: { kind: "read" },
};

/** 取一个工具的策略；没声明就当只读。 */
export function policyOf(name: string): ToolPolicy {
  return TOOL_POLICY[name] ?? { kind: "read" };
}

/** 一次判定的结果。 */
export type Verdict = "run" | "ask" | "hide";

/**
 * 判定一次工具调用。
 *
 * @param mode 用户选的档位
 * @param name 工具名
 * @returns `run` / `ask` / `hide`
 */
export function decide(mode: ConfirmMode, name: string): Verdict {
  const policy = policyOf(name);
  // 关掉的工具在任何档位下都不注入 —— 这是"关掉"的正确含义
  if (policy.enabled === false) return "hide";
  if (mode === "全部允许") return "run";
  // 每步确认：无论读写都要问
  if (mode === "每步确认") return "ask";
  // 按需确认：只拦会改东西的
  return policy.kind === "write" ? "ask" : "run";
}

/**
 * 该档位下**应当注入给模型**的工具名。
 *
 * `hide` 的不在这里 —— 注意区别：不是"注入了但会被拒"，而是**模型看不到**。
 * 这个区别有实际意义：模型看不到就不会在回复里说"我去调用 xxx"然后失败。
 *
 * @param mode 档位
 * @param all 全部工具名
 * @returns 要注入的名字（保持原顺序）
 */
export function injectableTools(mode: ConfirmMode, all: readonly string[]): string[] {
  return all.filter((name) => decide(mode, name) !== "hide");
}

/** 档位是否合法（从磁盘/本地存储读回来的东西一律不可信）。 */
export function normalizeConfirmMode(raw: unknown): ConfirmMode {
  return CONFIRM_MODES.includes(raw as ConfirmMode) ? (raw as ConfirmMode) : "全部允许";
}

/**
 * 被拦下时回给模型的那句话。
 *
 * 口径同 `unknownToolNotice`（goose / Factor 9）：**当成一次工具结果回注**，不抛异常。
 * 要说清三件事：没执行、等谁、别再试 —— 否则模型会在这一轮里反复重试同一个工具。
 */
export function pendingApprovalNotice(name: string, mode: ConfirmMode): string {
  return `已把这次「${name}」交给用户确认（当前档位：${mode}），**还没有执行**。请不要重试，直接把需要确认的事告诉用户。`;
}
