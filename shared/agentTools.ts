import { z } from "zod";
import { MEMORY_TEXT_LIMIT } from "./memory";

/**
 * **工具协议**的规格层（§141）。
 *
 * 为什么单独一层：工具的**声明**（名字、说明、参数 schema）要在两处用 ——
 * 主进程交给模型（`streamText({ tools })`）、测试里校验参数与回注文案；
 * 而**执行**只在主进程（那里才有 store 与文件系统）。
 * 所以把"声明"放共享层当**唯一事实来源**，执行单独绑定 —— 避免两处各写一份 schema。
 *
 * 这一层是研究结论的直接落地（`docs/优化计划.md` 批次 1）：
 *  - 工具的 schema 与实际校验同一处（opencode 的 `tool({ inputSchema })` 口径）；
 *  - 参数在进业务之前就被校验（schema 不合格 → 当 tool result 回注给模型，见 `unknownToolNotice`）；
 *  - 工具名是**稳定的字符串**（决定权限策略表怎么挂，批次 2）。
 */

/** 一条工具的声明。 */
export type AgentToolSpec = {
  name: string;
  description: string;
  /** zod schema —— 既是给模型的参数说明，也是执行前的校验。 */
  schema: z.ZodTypeAny;
};

/**
 * 一次读文件最多给模型多少字。
 *
 * 与其它工具输出的口径一致（400 → 8000，见 §"工具输出该给多少"）：
 * 给太少模型看不到关键段，给太多会把上下文顶爆。
 */
export const READ_FILE_MODEL_CHARS = 8000;
/**
 * 「写文件」的正文上限（与 `writeTool.WRITE_MAX_CHARS` 同一个数）。
 *
 * 为什么放在 shared 里：这个数要**同时**出现在工具说明（给模型看）与执行体（真拦）里。
 * 两处各写一份的话，"说明里 200000、执行体 20000"这种错没人会立刻发现 ——
 * 模型照着说明写、被拒绝，然后开始瞎猜。
 */
export const WRITE_FILE_MODEL_CHARS = 200_000;

export const MEMORY_SAVE_TOOL = "memory_save";
export const MEMORY_LIST_TOOL = "memory_list";

/**
 * 「记住一条」的说明。
 *
 * 写清楚**什么时候该用**（研究里 Cline 强调"需要复核的工具必须显式声明"，
 * 工具的 description 就是它的说明书）：用户明确要求"记住"时才存，
 * 不要把这次对话的内容随手记进去 —— 记忆是**跨会话长期注入**的，写错会一直影响后续。
 */
export const MEMORY_SAVE_DESC = [
  "把一条**长期有效**的事实或偏好存进用户的「记忆」；之后每次对话都会自动带上。",
  "只在用户明确要求「记住」「以后都按这个来」时使用。",
  "不要存一次性的任务内容、也不要存模型的推测。",
].join("");

export const MEMORY_SAVE_INPUT = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(MEMORY_TEXT_LIMIT)
    .describe(`要记住的内容，一句话（最多 ${MEMORY_TEXT_LIMIT} 字）`),
});

export const MEMORY_LIST_DESC = "列出当前记住的全部条目（每条一句）。";
export const MEMORY_LIST_INPUT = z.object({});

export const SCHEDULE_CREATE_TOOL = "schedule_create";
export const SCHEDULE_LIST_TOOL = "schedule_list";

/**
 * 「建定时任务」的说明。
 *
 * 依据：本体技能面板里就有这条命令（`shot-skills-panel-2.png` 的「定时任务
 * 创建、查看、更新或删除定时任务」）—— 也就是说它的 agent 真能做这件事。
 *
 * ⚠️ 说明里写清"只在用户明确要求定时/提醒时用"：定时任务是**会反复自己跑**的东西，
 * 被模型随手建一个的后果比写错一条记忆严重得多。
 */
export const SCHEDULE_CREATE_DESC = [
  "创建一个定时任务：到点按 `prompt` 自动跑一次。",
  "只在用户**明确要求**定时/提醒/每天/每周做某事时使用。",
  "标题写短（像任务名），prompt 写清到时候要做什么。",
].join("");

export const REPEAT_VALUES = ["noRepeat", "hourly", "daily", "weekly", "custom"] as const;

export const SCHEDULE_CREATE_INPUT = z.object({
  title: z.string().trim().min(1).max(30).describe("任务标题，短一些，例如「每日行业新闻」"),
  prompt: z.string().trim().min(1).max(200).describe("到点要执行的那句话，例如「汇总今天的行业新闻」"),
  repeat: z.enum(REPEAT_VALUES).describe("重复方式：noRepeat / hourly / daily / weekly / custom"),
  customMinutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 30)
    .optional()
    .describe("repeat=custom 时的间隔分钟数（5 ~ 43200）"),
});

export const SCHEDULE_LIST_DESC = "列出已有的定时任务（标题、重复方式、下次运行时间）。";
export const SCHEDULE_LIST_INPUT = z.object({});

export const CANVAS_ADD_NODE_TOOL = "canvas_add_node";

/** 本版支持的节点类型 —— **只放字段名已核实过的两种**。 */
export const CANVAS_NODE_KINDS = ["markdown", "code"] as const;

/**
 * 「往画布加节点」的说明。
 *
 * 依据：本体技能面板里就有「创建画布」这条命令（`shot-skills-panel-2.png`）。
 *
 * ⚠️ 支持的类型**故意只有两种**：画布上每种节点的 data 字段不同
 * （`markdown` 用 `text`、`code` 用 `code`、`image` 要 url……）。
 * 只放开**已经核实过字段名**的那两种 —— 其余的等核实了再加，
 * 而不是先放出去、让模型写出一个字段名不对的节点。
 */
export const CANVAS_ADD_NODE_DESC = [
  "往画布上加一个节点。",
  "kind 只支持 markdown（文本）与 code（代码）；text 是节点内容。",
  "画布没打开时会自动打开它。用户明确要求「放到画布上」「做个画布节点」时才用。",
].join("");

export const CANVAS_ADD_NODE_INPUT = z.object({
  kind: z.enum(CANVAS_NODE_KINDS).describe("节点类型：markdown 或 code"),
  text: z.string().min(1).max(2000).describe("节点内容（Markdown 原文或代码）"),
  lang: z.string().max(20).optional().describe("kind=code 时的语言，例如 python / ts"),
});

/* ============================================================
 * 子智能体（§150）
 *
 * 依据 cline 的 `spawn_agent`：**它有自己的一份上下文**，
 * 做完只回一份**汇合摘要**（不是它整段对话），成本要能上卷到父级。
 * ============================================================ */

export const LIST_FILES_TOOL = "list_files";

/**
 * 「列文件」的说明（2026-10-14）。
 *
 * 与 `read_file` 是一对：只读会让 agent"只能处理用户报了名字的文件" ——
 * 用户问"我云盘里有哪些东西""把云盘里的文档整理成目录"时会卡住。
 * 列出来之后，"先看有什么、再决定读哪个"这条路才通。
 */
export const LIST_FILES_DESC = [
  "列出用户**云盘 / 产物 / 导出目录**里的文件（名字、大小、在哪个目录）。",
  "用户问「我有哪些文件」「帮我看看云盘里有什么」，或者你不知道该读哪个文件时用它。",
  "只列文件名与大小，**不含正文**；要看内容再对具体文件用 read_file。",
].join("");

export const LIST_FILES_INPUT = z.object({});

export const READ_FILE_TOOL = "read_file";

/**
 * 「读文件」的说明（2026-10-14）。
 *
 * ## 为什么要有这个工具
 * 在此之前，agent **看不见用户提到的任何文件**：任务里说"把云盘里的季度总结改成三行"，
 * 它手上既没有内容、也没有读文件的手段，只能编或者反问。
 * 我们自己已经有两个功能把这件需求摆在那里了 ——
 * 悬浮窗的「问问豆包」（提示词里写的是"读一下这个文件：<路径>"）与聊天里的引用/资料，
 * 都在指望"模型能自己拿到文件内容"。这一条把它补上。
 *
 * ## 边界（在 description 里对模型说清楚，它会因此少撞墙）
 * 只读**用户自己的云盘 / 产物 / 导出目录**里的文本文件（与界面上那几个目录是同一批），
 * 目录之外一律读不到；非文本、空文件、超大文件都会如实回报，不会假装读到了。
 *
 * ⚠️ 名字与参数是本机版自己定的（本体那侧没有可引用的工具名）；
 * 但"agent 得能读用户提到的文件"这件事，是我们已经发出去的功能所要求的 —— 如实记着。
 */
export const READ_FILE_DESC = [
  "读取用户**云盘 / 产物 / 导出目录**里的一个文本文件，返回它的正文。",
  "用户提到某个文件的路径、或者需要看文件内容才能完成任务时用它。",
  "路径可以是完整绝对路径，**也可以只给文件名**（会在用户的云盘/产物目录里按名字找）。",
  "只给文件名而目录里有多个同名时，会返回候选路径让你指定 —— 不会替你猜一个读。",
  `单次最多返回 ${READ_FILE_MODEL_CHARS} 字，超出会截断并注明原文长度。`,
  "目录之外的文件、二进制文件、空文件都会如实说明读不到，不要凭路径猜测内容。",
].join("");

export const READ_FILE_INPUT = z.object({
  path: z.string().trim().min(1).describe("要读的文件的绝对路径"),
});

export const WRITE_FILE_TOOL = "write_file";

/**
 * 「写文件」的说明（2026-10-14）。
 *
 * ## 为什么要有这个工具
 * `read_file` / `list_files` 之后，agent 能**看**用户的文件了，但仍然**写不了** ——
 * 于是"把云盘里的调研内容整理成一份纪要""把这几个要点存成 markdown"这类任务
 * 只能把内容吐在对话里，让用户自己复制粘贴。
 * 界面上早就有对它的期待：「从对话创建文档」、AI 文档、画布产物 ——
 * 都是"产出要落到用户能再打开的地方"，而不是留在聊天记录里。
 *
 * ## 边界（在 description 里对模型说清楚，它会因此少撞墙）
 * 只能写到用户的**云盘 / 产物 / 导出目录**（与 `read_file` 同一道墙）；
 * **默认不覆盖** —— 同名文件存在就报错，要覆盖必须显式 `overwrite: true`；
 * 只写 UTF-8 文本（图片/压缩包/音视频这类二进制格式明确拒绝）。
 *
 * ⚠️ 与 `read_file` 同一个口径：名字与参数是本机版自己定的（本体那侧没有可引用的工具名）。
 * 这条工具在**审批闸门**里声明为 **write**（`shared/permissions.ts`）——
 * 「按需确认」档下会先问一次，因为新建/覆盖是用户目录里**不可逆**的改动。
 */
export const WRITE_FILE_DESC = [
  "在用户的**云盘 / 产物 / 导出目录**里写一个文本文件（UTF-8），返回落点。",
  "适合：把整理好的内容落成一份文件（纪要 / 清单 / 报告 / 代码片段）留给他以后打开。",
  "**默认不覆盖**：已经存在同名文件时会返回失败；确实要覆盖就再调一次并把 overwrite 设成 true。",
  "只写文本：图片、压缩包、音视频这类二进制格式会被拒绝（那些要用生成或上传）。",
  `单次正文上限 ${WRITE_FILE_MODEL_CHARS} 字，超了先拆成几个文件。`,
  "目录之外的路径写不了；写不进去会把原因说清楚，别换个相近的路径反复试。",
].join("");

export const WRITE_FILE_INPUT = z.object({
  path: z.string().trim().min(1).describe("目标文件的绝对路径（或只给文件名，会写到云盘根目录）"),
  content: z.string().describe("要写入的正文（UTF-8 文本）"),
  overwrite: z.boolean().optional().describe("允许覆盖同名文件；不传即不允许（默认拒绝覆盖）"),
});

export const SPAWN_AGENT_TOOL = "spawn_agent";

/**
 * 最多嵌套几层。
 *
 * **1** = 子智能体不能再派子智能体。理由：任务是"把一件独立的事办完并回报"，
 * 再往下派只会让"这件事归谁做"变模糊，而且成本会指数膨胀。
 * 这一层限制靠**不给子智能体注入 `spawn_agent`** 实现
 * （不是"注入了但会被拒" —— 那样模型会试一次才失败）。
 */
export const MAX_SUBAGENT_DEPTH = 1;

export const SPAWN_AGENT_DESC = [
  "派一个子智能体去独立办一件事，它做完回一份要点。",
  "适合：能独立完成的子任务（查一批资料、分别处理几个来源、互相独立的几件事）。",
  "不适合：与当前对话强相关的一小步 —— 那种直接自己做，别绕一层。",
  "交给它的 `task` 要**自包含**（它看不到你们这段对话）。",
].join("");

export const SPAWN_AGENT_INPUT = z.object({
  task: z.string().trim().min(1).max(500).describe("自包含的任务说明（它看不到当前对话）"),
  context: z.string().max(2000).optional().describe("需要一并交代的背景材料"),
});

/**
 * 子智能体的提示词。
 *
 * 关键要求：**只回要点报告，不要把过程复述一遍**（Factor 10 的"小上下文"）——
 * 它那几轮的完整记录如果全灌回父级，等于白折腾一层。
 *
 * @param task 任务说明
 * @param context 背景材料
 * @returns `system` 与 `user`
 */
export function subagentPrompt(task: string, context?: string): { system: string; user: string } {
  const system = [
    "你是一个**子智能体**：只办交给你这一件事，办完就回一份要点。",
    "",
    "## 回报的规矩",
    "- 只给**要点**：做了什么、结论是什么、拿到哪些具体结果（数字、名字、原文关键句）。",
    "- **不要**把过程一步步复述一遍，也不要写寒暄与客套。",
    "- 需要工具就用；工具说要用户确认的，**如实写进回报**（别假装做完了）。",
    "- 做不到就说做不到，不要编。",
  ].join("\n");
  const user = context?.trim() ? `任务：${task}\n\n交代的背景：\n${context.trim()}` : `任务：${task}`;
  return { system, user };
}

/** 子智能体回报的结构（父级据此写留痕、上卷成本）。 */
export type SubagentReport = {
  ok: boolean;
  /** 要点报告。 */
  summary: string;
  /** 用了几步（模型轮次）。 */
  steps: number;
  /** 调过哪些工具（名字，按顺序）。 */
  toolCalls: string[];
  /** 需要用户确认而**没执行**的动作（审批穿透的证据）。 */
  /**
   * 被闸门拦下、**没有执行**的调用（§176 起是结构化的：工具名 + 参数都留下）。
   */
  blocked: SubagentBlocked[];
  /** token 用量，用于成本上卷。 */
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
};

/*
 * ⚠️ 这张表必须放在**所有常量声明之后**（§150 踩过）：
 * 它引用了上面那些 `const`，而 `const` 只是提升不初始化 —— 放前面会在**加载时**
 * 直接抛 TDZ 错误，整个模块起不来（不是运行时才出问题）。
 *
 * **顺序即注入给模型的顺序**。
 */
/**
 * 子智能体里**被闸门拦下**的一次调用（§176）。
 *
 * ## 为什么把它做成结构化的
 *
 * 原来 `blocked` 存的是**显示用的字符串**（`describeToolResult` 的输出）——
 * 于是父级只能告诉用户「子智能体有 1 项没办成」，**却没有让它办成的办法**：
 * 字符串里没有工具名、没有参数，谁都执行不了。
 *
 * 结构化之后，父级可以把它们**挂成自己步上的待批准项**，
 * 复用 §144 那套「放行就地执行」的按钮 —— 用户点一下，那次调用就真的执行了。
 *
 * 依据 12-factor-agents 与 opencode 的做法：**跨边界的审批必须能带上下文回来**；
 * 不能因为「发生在子智能体里」就变成一条无法处置的通知。
 */
export type SubagentBlocked = {
  toolCallId: string;
  name: string;
  input?: unknown;
};

/**
 * 把子智能体上交的调用变成**父级步上的待批准留痕**（§176）。
 *
 * 生成的每一条都是 `pending: true` —— 界面据此给出「允许 / 拒绝」两个按钮。
 *
 * @param blocked 子智能体上交的调用
 * @param reason 它们是从哪儿来的（写进那一行，让用户知道不是本轮的调用）
 * @returns 待批准留痕
 */
export function blockedToTraces(
  blocked: readonly SubagentBlocked[] | undefined,
  reason = "子智能体想做但没被批准",
): ToolTrace[] {
  return (blocked ?? []).map((b) => ({
    toolCallId: b.toolCallId,
    name: b.name,
    ok: true,
    pending: true,
    line: `⚙ ${toolLabel(b.name)}：${reason}（等你确认）`,
    ...(b.input === undefined ? {} : { input: b.input }),
  }));
}

/**
 * 从落盘的（不可信）数据里恢复工具留痕（§176）。
 *
 * ## 这是顺带逮到的一个真缺陷
 *
 * 步骤恢复时原来**只恢复 `id/role/text/at` 这几项，把 `tools` 整个丢了** ——
 * 于是**重启之后工具留痕全没了**。后半句更要紧：
 * 一条 `pending: true`（等用户点确认）的留痕，重启后会**消失得无影无踪** ——
 * 用户看不到它、也批不了它，而那次调用永远停在那里。
 *
 * 这与 §143/§144 的整个设计相冲：**闸门的意义就是"用户看得见并决定"**。
 *
 * ## 规矩
 *
 * 磁盘上的东西不可信（§49 那次的教训）：逐项类型检查，缺 `id` 或 `name` 的直接丢。
 *
 * @param raw 落盘的数组
 * @returns 干净的留痕
 */
export function normalizeToolTraces(raw: unknown): ToolTrace[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
    .map((x) => {
      const name = typeof x.name === "string" ? x.name : "";
      const toolCallId = typeof x.toolCallId === "string" ? x.toolCallId : "";
      if (!name || !toolCallId) return null;
      const trace: ToolTrace = {
        toolCallId,
        name,
        ok: x.ok !== false,
        line: typeof x.line === "string" ? x.line : toolLabel(name),
        ...(x.pending === true ? { pending: true } : {}),
      };
      if ("input" in x) trace.input = x.input;
      if ("output" in x) trace.output = x.output;
      if (typeof x.error === "string") trace.error = x.error;
      return trace;
    })
    .filter((x): x is ToolTrace => x !== null);
}

/**
 * 把**新算出来的**待批准留痕并入**界面上已有的**那一份，并且**已有优先**。
 *
 * ## 为什么必须"已有优先"（C2 撞到的一个真回归）
 *
 * 留痕现在由投影算出来（`shared/sessionLog.ts`）。流式过程中每来一条 `tool-result`
 * 都会重算一次投影 —— 如果界面直接**用投影覆盖**列表，那么：
 * 用户点了「允许」→ 那条留痕被标成已执行（这是**渲染进程的状态**）→
 * 但投影里它仍然是 `pending: true`（主进程不知道谁批过）→ 下一次覆盖
 * **把「允许」抹掉、按钮又冒出来**。
 *
 * 所以合并规则是：**按 `toolCallId` 认人，界面已有的那条说了算**（它带着用户的决定），
 * 投影只负责补上"这一轮新出现的"那些。
 *
 * @param existing 界面上已有的（可能含用户已处置的）
 * @param incoming 投影刚算出来的
 * @returns 合并后的列表（顺序沿用 existing，新项追加在后）
 */
export function mergeToolTraces(existing: readonly ToolTrace[], incoming: readonly ToolTrace[]): ToolTrace[] {
  const seen = new Set(existing.map((t) => t.toolCallId));
  return [...existing, ...incoming.filter((t) => !seen.has(t.toolCallId))];
}

export const AGENT_TOOLS: readonly AgentToolSpec[] = [
  { name: MEMORY_SAVE_TOOL, description: MEMORY_SAVE_DESC, schema: MEMORY_SAVE_INPUT },
  { name: MEMORY_LIST_TOOL, description: MEMORY_LIST_DESC, schema: MEMORY_LIST_INPUT },
  { name: SCHEDULE_CREATE_TOOL, description: SCHEDULE_CREATE_DESC, schema: SCHEDULE_CREATE_INPUT },
  { name: SCHEDULE_LIST_TOOL, description: SCHEDULE_LIST_DESC, schema: SCHEDULE_LIST_INPUT },
  { name: CANVAS_ADD_NODE_TOOL, description: CANVAS_ADD_NODE_DESC, schema: CANVAS_ADD_NODE_INPUT },
  { name: SPAWN_AGENT_TOOL, description: SPAWN_AGENT_DESC, schema: SPAWN_AGENT_INPUT },
  { name: READ_FILE_TOOL, description: READ_FILE_DESC, schema: READ_FILE_INPUT },
  { name: LIST_FILES_TOOL, description: LIST_FILES_DESC, schema: LIST_FILES_INPUT },
  { name: WRITE_FILE_TOOL, description: WRITE_FILE_DESC, schema: WRITE_FILE_INPUT },
];

/** 按名字取声明；没有就是 `undefined`（→ 走"未知工具"那条路）。 */
export function toolSpec(name: string): AgentToolSpec | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

/**
 * **未知工具 / 参数不合格**时回注给模型的那句话。
 *
 * 这是 goose 的做法（也是 12-factor 的 Factor 9「把错误压缩进上下文」）：
 * **不抛异常、不静默丢掉**，而是当成一次工具结果发回去，让模型自己纠正再试。
 *
 * 好处很直接：省掉一层重试逻辑，而且模型看到的失败原因与它调用的参数在同一个上下文里。
 *
 * @param name 模型调用的工具名
 * @param reason 可选的更具体原因（例如 schema 校验失败的信息）
 * @returns 一句话
 */
export function unknownToolNotice(name: string, reason?: string): string {
  const known = AGENT_TOOLS.map((t) => t.name).join(" / ");
  const head = `没有名为「${name}」的工具。可用工具：${known}。`;
  return reason ? `${head}（参数问题：${reason}）请修正后重试。` : `${head}请改用其中一个。`;
}

/** 工具名 → 给人看的短标签（界面文案与测试共用一份）。 */
export function toolLabel(name: string): string {
  if (name === MEMORY_SAVE_TOOL || name === MEMORY_LIST_TOOL) return "记忆";
  if (name === SCHEDULE_CREATE_TOOL || name === SCHEDULE_LIST_TOOL) return "定时任务";
  if (name === CANVAS_ADD_NODE_TOOL) return "画布";
  if (name === SPAWN_AGENT_TOOL) return "子智能体";
  if (name === READ_FILE_TOOL) return "读文件";
  if (name === LIST_FILES_TOOL) return "列文件";
  if (name === WRITE_FILE_TOOL) return "写文件";
  return name;
}

/**
 * 把一次工具调用压成界面上的一行小字（**行内展示**，不抢正文）。
 *
 * 为什么要在界面上留一行：模型"调了工具"这件事用户应当看得见 ——
 * 否则"记忆被写进去了"就成了暗箱操作。这与本项目反复清的
 * "看着有、其实没用"是**反过来的**要求：**真做了的事要看得出来**。
 */
export function toolLine(name: string, ok: boolean, detail?: string): string {
  const label = toolLabel(name);
  if (!ok) return `⚙ ${label}失败${detail ? `：${detail}` : ""}`;
  // 成功时**必须有分隔**：写成「⚙ 记忆已完成」会黏成一坨（测试逮到过）
  return `⚙ ${label}：${detail ?? "已完成"}`;
}

/**
 * 把一次工具调用的**结果**压成一小段可读文本（给模型看、也给界面看）。
 *
 * 为什么不直接把 JSON 塞给用户：工具结果是机器字段（`{ok,count,note}`），
 * 界面上要的是"记住了 3 条"。这里做一次，界面与测试共用同一份措辞。
 *
 * @param name 工具名
 * @param ok 成功与否
 * @param output 原始结果（成功时）
 * @param error 错误信息（失败时）
 * @returns 一行文本
 */
/**
 * 把工具**收到的参数**说成一小句（§175）。
 *
 * ## 为什么需要它
 *
 * 原来留痕只写"结果"：`⚙ 记忆：已保存，当前 3 条`。
 * 看的人立刻会问一句：**"它把什么记进去了？"** —— 而那个答案只在参数里。
 *
 * 参数是 AI SDK 在 `tool-call` 事件里给的（`part.input`），本来就拿得到；
 * 缺的只是有人把它说出来。
 *
 * ## 有边界
 *
 * 每个工具**自己**决定说哪一部分（见下面），**猜不出来就什么都不说** ——
 * 不硬编一句"已执行"糊过去（那等于把"看得见"又变回"看不见"）。
 *
 * @param name 工具名
 * @param input 模型给的参数（形状不可信，一律当 `unknown` 处理）
 * @returns 一小句；说不出来给空串
 */
export function toolArgsSummary(name: string, input: unknown): string {
  const cut = (value: unknown, n: number): string => {
    const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    if (!text) return "";
    return text.length > n ? `${text.slice(0, n)}…` : text;
  };
  const obj = (input ?? {}) as Record<string, unknown>;

  if (name === MEMORY_SAVE_TOOL) {
    const text = cut(obj.text, 40);
    return text ? `写入「${text}」` : "";
  }
  if (name === SCHEDULE_CREATE_TOOL) {
    const title = cut(obj.title, 24);
    return title ? `「${title}」` : "";
  }
  if (name === CANVAS_ADD_NODE_TOOL) {
    const kind = obj.kind === "code" ? "代码节点" : obj.kind === "markdown" ? "文本节点" : "";
    const what = cut(obj.title ?? obj.content, 24);
    if (kind && what) return `${kind}「${what}」`;
    return kind;
  }
  if (name === SPAWN_AGENT_TOOL) {
    const task = cut(obj.task, 40);
    return task ? `任务：${task}` : "";
  }
  if (name === WRITE_FILE_TOOL) {
    /*
     * 写文件的留痕要说清**写哪儿**：光写"写文件"等于什么都没说 ——
     * 用户最关心的正是"它要动我哪个文件"，而这在**批准之前**就得看得见。
     *
     * ⚠️ 自己切最后一段，不用 `node:path`：这个模块**也打进渲染层**，
     * 在那边 `node:path` 是拿不到的（`shared/` 不许依赖 node 内建）。
     */
    const raw = cut(obj.path, 80);
    const file = raw ? (raw.split(/[\\/]/).pop() ?? "") : "";
    const n = typeof obj.content === "string" ? obj.content.length : 0;
    if (!file) return "";
    return obj.overwrite === true ? `覆盖「${file}」（${n} 字）` : `「${file}」（${n} 字）`;
  }
  // 其余工具没有值得说的参数（`memory_list` / `schedule_list` 之类）
  return "";
}

export function describeToolResult(
  name: string,
  ok: boolean,
  output?: unknown,
  error?: string,
  input?: unknown,
): string {
  /*
   * 参数摘要挂在**末尾**（§175）：结果在前、参数在后。
   * `（…）`包起来，读起来是"补一句它刚才传了什么"，
   * 而且**不改变**原来的那些断言（没给 input 时一个字符都不变）。
   */
  const withArgs = (line: string): string => {
    const args = toolArgsSummary(name, input);
    return args ? `${line}（${args}）` : line;
  };
  if (!ok) return withArgs(toolLine(name, false, error?.slice(0, 60)));
  /*
   * 被审批闸门拦下（§143）：**没执行**，在等用户点确认。
   * 这一条必须与"已完成"长得明显不同 —— 否则用户会以为事已经做完了。
   */
  const pending = output as { pending?: boolean } | undefined;
  if (pending?.pending) return withArgs(`⚙ ${toolLabel(name)}：等你确认（还没执行）`);
  if (name === MEMORY_SAVE_TOOL) {
    const o = output as { count?: number; note?: string } | undefined;
    if (o?.note) return withArgs(toolLine(name, true, o.note));
    const n = typeof o?.count === "number" ? o.count : undefined;
    return withArgs(toolLine(name, true, n === undefined ? "已保存" : `已保存，当前 ${n} 条`));
  }
  if (name === MEMORY_LIST_TOOL) {
    const o = output as { count?: number } | undefined;
    return withArgs(toolLine(name, true, `当前 ${typeof o?.count === "number" ? o.count : 0} 条`));
  }
  if (name === SCHEDULE_CREATE_TOOL) {
    const o = output as { title?: string; next?: string } | undefined;
    if (o?.title) return withArgs(toolLine(name, true, `已创建「${o.title}」${o.next ? `，下次 ${o.next}` : ""}`));
    return withArgs(toolLine(name, true, "已创建"));
  }
  if (name === SCHEDULE_LIST_TOOL) {
    const o = output as { count?: number } | undefined;
    return withArgs(toolLine(name, true, `当前 ${typeof o?.count === "number" ? o.count : 0} 条`));
  }
  if (name === CANVAS_ADD_NODE_TOOL) {
    const o = output as { kind?: string; opened?: boolean } | undefined;
    const what = o?.kind === "code" ? "代码节点" : "文本节点";
    return withArgs(toolLine(name, true, `已在画布上放了一个${what}${o?.opened ? "（并打开了画布）" : ""}`));
  }
  if (name === SPAWN_AGENT_TOOL) {
    const o = output as Partial<SubagentReport> | undefined;
    if (!o?.ok) return withArgs(toolLine(name, false, o?.error ?? "子智能体没有完成"));
    // 成本上卷：把子智能体用掉的 token 写在留痕里（用户看得见这一层花了多少）
    const tokens = (o.usage?.inputTokens ?? 0) + (o.usage?.outputTokens ?? 0);
    const cost = tokens ? `，约 ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : "";
    const blocked = o.blocked?.length ? `，${o.blocked.length} 项等你确认` : "";
    return withArgs(toolLine(name, true, `完成（${o.steps ?? 0} 步${cost}${blocked}）`));
  }
  return withArgs(toolLine(name, true));
}

/**
 * 工具调用在**这一步**上的留痕（step 事件化）。
 *
 * 依据 `docs/优化计划.md` 批次 1：一次模型调用 + 该步工具执行 = 一个 step，
 * 记下 `{工具名, 成败, 结果}`。回滚、快照、压缩以后都挂在这个粒度上。
 */
export type ToolTrace = {
  /**
   * AI SDK 给这次调用分配的 id。
   *
   * ⚠️ **必须记**（§144）：一次回复里可能有多**次**工具调用（实测确实会）。
   * 界面上要"放行其中某一次"时，只能按 id 找 —— 按工具名找会放行错那一次。
   */
  toolCallId: string;
  name: string;
  ok: boolean;
  /** 界面上那一行小字。 */
  line: string;
  /** 被审批闸门拦下、在等用户确认（此时**没有执行**）。 */
  pending?: boolean;
  /** 模型给的参数（原样保留：放行时要原样执行，也方便排错看出它传了什么）。 */
  input?: unknown;
  output?: unknown;
  error?: string;
};

/** 用户点了「拒绝」时那一条留痕的文案。 */
export function rejectedLine(name: string): string {
  return `⚙ ${toolLabel(name)}：你已拒绝`;
}

