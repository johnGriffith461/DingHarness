/**
 * 工作台的任务模型（阶段 10，依据 `.verify\tour\` 的实机遍历，见 HANDOFF §25）。
 *
 * 原版不是"聊天窗口"，是**任务工作台**：发一句话就开出一个任务，
 * 它自己起标题、自己问清关键信息、跑完给你产物。这几个机制里有三件事
 * 必须用纯逻辑做对、且能离线验证：
 *
 *   1. **任务自动命名** —— 列表里显示的是「产品周报撰写」，不是用户发的原文
 *   2. **进度计时文案** —— 「已处理 31 秒」→「已处理 2 分 35 秒」→ 完成后「共用时 3 分 41 秒 ›」
 *   3. **澄清提问卡的推进** —— 同一张卡逐题走，最多 3 题，走完才继续干活
 */

/** 任务在生命周期里的位置。 */
export type TaskStage = "running" | "awaiting" | "done" | "failed";

import type { ContextIndex } from "@engine/core/contextManager";
import type { PlanState } from "@engine/runtime/planMode";
import type { SavedAttachmentMeta } from "@shared/ipc";
import { ARTIFACT_FORMATS, type Artifact, type ArtifactKind } from "./artifact";
import { normalizeToolTraces, type ToolTrace } from "@shared/agentTools";
import type { StepUsage } from "@shared/cost";

/** 对话里的一条。 */
export type TaskStep = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  /** AI 消息的「消耗」（原版显示「消耗 0.48」）。**本机版是按字数估的**，见 `shared/cost.ts`。 */
  cost?: number;
  /**
   * 这一步的**真实用量**（provider 给的 tokens，C5）。
   *
   * ⚠️ 它与 `cost` 是**两个不同的东西**：`cost` 是界面那个数（估的、为了与本体形态一致），
   * `usage` 是真的。一起留着，"显示的数是估的"这件事才说得清、也才有的对照。
   */
  usage?: StepUsage;
  /**
   * 产出这条 AI 回复时**实际发出去的用户内容**。
   *
   * 「重新生成」要能原样再问一遍。光靠"上一条用户消息"重建是不够的：
   * 那一轮可能已经带着前面积累的问答，重建会得到不同的上下文、也就不是"重新生成"了。
   */
  askedWith?: string;
  /** 用户对这条回复的评价（有帮助 / 没帮助）；原版也是本地留痕。 */
  rating?: "up" | "down";
  /**
   * 产出这条回复时**用过的工具**（§141 step 事件化）。
   *
   * 一次模型调用 + 该步工具执行 = 一个 step；工具留痕挂在 step 上，
   * 而不是挂在任务上 —— 因为"哪一步用了什么工具"才会被后面用到
   * （回滚到某一步、按步压缩上下文、重放）。
   */
  tools?: ToolTrace[];
  /**
   * 这一步额外要告诉用户的一件事（§149）。
   *
   * 现在只用于**"更早的对话已压缩为摘要"**：压缩改变了模型看到的上下文，
   * 用户有权知道。放在步骤上而不是飘一个 toast —— 飘提示刷新就没了，
   * 回头翻这段对话会不知道当时发生了什么。
   */
  note?: string;
  /**
   * G2：这一步随消息发出的附件（**只存引用**，不存 base64）。
   *
   * 重启后 `TaskView` 按 `path` 通过主进程读回缩略图；文件被清理时显示占位。
   * 旧盘没有该字段 = 这一步没有附件（不补空数组，免得旧数据多出一个字段）。
   */
  attachments?: SavedAttachmentMeta[];
};

/**
 * 「上一次关窗口时那一轮被打断了」这句说明（审计 P139 / P211）。
 *
 * 它**是给人看的话**，不是判据：判据是下面 `interrupted` 那个真值
 * （由 `engine/core/recovery.ts` 的 `interruptedFromStage` 判、`taskPersist` 记）。
 * 写它的地方（`taskPersist.normalizeTask`）与认得它的地方（`continueTargetOf`）
 * 都从这里取，别各写一份字符串。
 */
export const INTERRUPTED_NOTE = "上次关闭时被中断";

/** 澄清提问卡里的一个选项。 */
export type TaskOption = {
  /** 主文案，例如「拼多多家纺/母婴店」。 */
  label: string;
  /** 一行的补充说明，例如「围绕你经营的拼多多店铺写店铺/产品运营周报」。 */
  hint: string;
};

/** 一张澄清提问卡。 */
export type TaskQuestion = {
  id: string;
  /** 问句本身。 */
  text: string;
  options: TaskOption[];
};

/** 一个问题连同它的选项；对齐原版"最多 3 题、逐题推进"。 */
export const MAX_QUESTIONS = 3;

/** 任务的两套身份（A3）：编码 agent 与办公任务助手的提示词不同。 */
export type TaskMode = "coding" | "office";

/**
 * 读一个任务的模式。
 *
 * 旧任务没有 `mode` 字段（这一版之前写下的 `tasks.json`）——按 `office` 走，
 * 与它们当初创建时的行为一致。**不按首页当前模式猜**：那会让旧对话突然换了身份。
 */
export function taskMode(task: Pick<WorkTask, "mode"> | undefined | null): TaskMode {
  return task?.mode === "coding" ? "coding" : "office";
}

/** 一个任务。 */
export type WorkTask = {
  id: string;
  /**
   * 这段任务是**编码**还是**办公**（A3）。
   *
   * 创建时从首页模式写入并随任务落盘：提示词按它选，所以它必须是任务的事实，
   * 不能读"现在的首页开关"—— 否则用户切一下首页，同一段对话的身份就漂了。
   *
   * 可选：这一版之前写下的 `tasks.json` 没有它，读到时按 `office`（`taskMode`）。
   */
  mode?: TaskMode;
  /** 自动归纳出来的标题（不是用户原文）。 */
  title: string;
  /** 用户发的第一句，留作副信息。 */
  brief: string;
  createdAt: number;
  stage: TaskStage;
  /** 开始计时的时间点；null 表示还没开始。 */
  startedAt: number | null;
  /** 结束时间点；有值时进度文案切成「共用时」。 */
  finishedAt: number | null;
  steps: TaskStep[];
  /** 待回答的问题队列。 */
  questions: TaskQuestion[];
  /** 当前问到第几题（0 基）。 */
  questionIndex: number;
  /** 正在跑的话术，例如「正在询问用户」。 */
  activity: string;
  /**
   * **流式中的正文草稿**（2026-10-14 补）。
   *
   * 在此之前工作台流式时不显示正文：只有一行「正在回复」，整段回答**结束时才蹦出来**
   * （对照：聊天侧一直是逐字显示的）。这个字段就是那段的落点。
   *
   * ⚠️ **不落盘**：它每几十毫秒变一次，写进 `tasks.json` 纯属浪费；
   * 重启后也不需要它（被中断的那一步本来就会被标成 failed）。
   * 落盘那侧会剥掉它（见 `taskPersist.ts`），恢复那侧也不认它（见 `normalizeTask`）。
   */
  draft?: string;

  /**
   * **用户随这一轮交给 agent 的资料**（2026-10-14 补）。
   *
   * 输入区那条占位文案是本体原话（「发消息或创建任务... / 使用技能 @ 添加资料」），
   * 而 `@` 在我们这儿只出了常用语 —— 界面承诺过、功能没做。这是它的落点：
   * 选中的文件读成文本（`fileContextBlock`，每个 ≤12000 字），随请求一起发出去。
   *
   * 为什么挂在任务上而不是只放在输入框：「先问再干」那条路上要先提问、用户答完才干活
   * （`buildDoPrompt`），资料得**跨过这次往返**还在 —— 只存在输入框里的话，
   * 干活的最后一步就把它丢了（模型拿着资料提问，然后不带资料干活）。
   *
   * ⚠️ **不落盘**：最多 3 个文件 × 12000 字，写进 `tasks.json` 是几万字的负担；
   * 重启后要重新添加（`taskPersist` 落盘前剥掉、`normalizeTask` 也不认它）。
   */
  material?: string;
  /** 这个任务产出的文件（阶段 11.1）。 */
  artifacts: Artifact[];

  /**
   * 最近一次**打开**这段对话的时刻（2026-10-16 审计 P266）。
   *
   * 任务中心的「最近访问」一栏原来按 `createdAt` 排（那一行注释写的是"刚访问过就该排前面"）——
   * 于是"昨天建的、今天又聊了几轮"的对话排在**今天新建的**后面：
   * 那一栏显示的其实是「最近创建」。
   *
   * 这是一个**真值**（用户点开它、或在那段里接着说一句时更新），所以随任务落盘 ——
   * 重启之后"最近访问"还得是最近访问过的那些。没打开过的老任务没有这个字段，
   * 排序时回落到 `createdAt`（不编一个访问时刻出来）。
   */
  openedAt?: number;

  /**
   * **恢复时那一轮被打断了吗**（审计 P139 / P211）。
   *
   * 这是一个**真值**，不是又一句文案：`taskPersist.normalizeTask` 恢复任务时
   * 用引擎的判据（`engine/core/recovery.ts` 的 `interruptedFromStage`）算出它、
   * 随任务落盘；「继续」按钮要不要出现就看它。
   *
   * ⚠️ 在这之前，桌面端是拿 `activity` 那句说明**做字符串匹配**认这件事的 ——
   * 于是"连接被中断"这种报错（说的是网络断了）也会长出一颗「继续」按钮。
   * 新数据一律看这个字段；旧盘（这次修复之前写下的 `tasks.json`）没有它，
   * 只能按那句说明认一次（见 `continueTargetOf` 的兜底）。
   */
  interrupted?: boolean;

  /**
   * 计划模式（G1）的**每任务状态机**。
   *
   * 全局开关（`planMode.ts` 的 localStorage）只表示"用户想用计划模式"；
   * 这一段对话走到哪一步是任务自己的事实，必须随任务落盘 ——
   * 否则重启之后面板消失，批准过的计划也无从续上。
   *
   * 可选：旧盘没有该字段 = `idle`。
   */
  planState?: PlanState;

  /** 模型给出的计划原文（可编辑；批准时写盘的就是它）。可选 = 还没生成。 */
  planText?: string;

  /** 批准后写进 `.ding/plans/<sessionId>.md` 的路径。 */
  planPath?: string;

  /** 写盘失败的原因（面板显示"未落盘"，但**不阻塞执行**）。 */
  planWriteError?: string;

  /**
   * 这段会话已经做过几次**摘要式压缩**（V6-1c ICM 的计数）。
   *
   * 用途只有一个：`decideContext` 判断"再压就是摘要的摘要"。
   * 它是真值、随任务落盘；老任务没有这个字段时按 0 算（不编一个次数）。
   */
  contextCompactions?: number;

  /**
   * 最近一次生成的**上下文索引**（V6-1c）。
   *
   * 与摘要不同：索引从**事件流/任务事实**生成，不调模型、不丢锚点，
   * 所以切会话/重启之后还能按 `anchor` 回放核对。随任务落盘。
   */
  contextIndex?: ContextIndex;
};

/* ============================================================
 * 1. 任务自动命名
 * ============================================================ */

/** 开头的客气/填充词，归纳标题时要去掉。 */
const LEADING_FILLER = /^(帮我|请|麻烦|我想要|我需要|我要|能不能|可以|帮忙|给我|想让你|希望你)+/;
/**
 * 开头的「动作 + 量词」，例如「写一份」「整理一下」「生成一张」。
 *
 * 必须去掉：实测原版把「帮我写一份简短的产品周报，…」命名为「产品周报撰写」，
 * 而不是把动作词也留在标题里。早期实现漏了这一条，产出
 * 「写一份简短的产品周报撰写」这种又长又别扭的标题。
 */
const LEADING_ACTION =
  /^(?:制作|写|做|生成|整理|制定|拟定|起草|撰写|编写|翻译|汇总|梳理|排版|出|来|搞|准备|弄|创作|设计)\s*(?:一份|一个|一张|一段|一条|一篇|一下|个|份|张|段|条|篇|次)?\s*/;
/** 开头的修饰语，例如「简短的」「详细的」「正式的」。 */
const LEADING_MODIFIER =
  /^(?:简短的|详细的|正式的|完整的|大致的|规范的|简单的|粗略的|一份|一个|一张|一段|一条|一篇|简单|粗略)\s*/;
/**
 * 开头的**产物格式词**，例如「Word 写一份总结汇报」里的 `Word `。
 *
 * 原版的推荐卡就是这种写法（「Word 写一份总结汇报」「PPT 制作一份 TED 风格演讲」），
 * 用户直接点就用这句话当任务。格式词是**要什么格式**、不是**做什么**，
 * 留在标题里会变成「Word 写一份总结汇报：本撰写」这种怪东西。
 */
const LEADING_FORMAT = /^(?:word|excel|ppt|pptx|xlsx|docx|markdown|html|表格|文档|幻灯片)\s+/i;
/** 结尾的礼貌尾巴。 */
const TRAILING_FILLER = /(吧|好吗|谢谢|，谢谢|。谢谢)?[。．.!！?？~～\s]*$/;

/** 产物类型 → 更贴切的动词后缀（对标原版「产品周报**撰写**」）。 */
const ARTIFACT_SUFFIX: Array<[RegExp, string]> = [
  [/(周报|日报|月报|报告|总结|汇报)/, "撰写"],
  [/(PPT|幻灯片|演示|演讲)/i, "制作"],
  // `表$` 是必要的：「销售表」「统计表」这类以「表」结尾的很常见，
  // 只认「表格」两个字会漏掉它们（实测漏过一次）
  [/(报表|表格|清单|Excel|统计|表$)/i, "整理"],
  [/(画布|脑图|导图|可视化)/, "绘制"],
  [/(方案|计划|规划)/, "拟定"],
  [/(代码|脚本|程序)/, "编写"],
  [/(翻译|译成|英文|日文)/, "翻译"],
  [/(审核|检查|校对|润色)/, "润色"],
];

/**
 * 从用户第一句话里归纳出一个任务标题（**本地启发式**，确定性、可离线验证）。
 *
 * 原版的标题看着是模型归纳的。这里先用规则拿到一个不差的标题，
 * 立即显示、不用等网络；模型可用时再由调用方异步换成更贴切的一版
 * （`refineTitle` 的职责留给上层，本函数只保证"离线也有标题"）。
 *
 * @param message 用户发的第一句
 * @returns 归纳出的标题；实在提不出东西就退成「新工作任务」
 */
export function autoTaskTitle(message: string): string {
  let text = String(message ?? "").trim();
  if (!text) return "新工作任务";

  // 去掉开头的客气词与结尾的礼貌尾巴
  text = text.replace(LEADING_FILLER, "").replace(TRAILING_FILLER, "").trim();
  // 产物格式词（Word / PPT…）不是任务内容
  text = text.replace(LEADING_FORMAT, "").trim();

  // 只取首个分句 —— 后面通常是补充说明，塞进标题会又长又杂。
  // **冒号也要切**：中文里冒号后面基本都是补充（「总结汇报：本周做了…」）。
  const head = text.split(/[，,；;。.！!？?：:\n]/)[0]?.trim() ?? "";
  if (head) text = head;

  // 反复剥掉开头的动作词与修饰语，直到不再变化（「写一份简短的产品周报」要剥两层）
  for (let i = 0; i < 4; i += 1) {
    const before = text;
    text = text.replace(LEADING_ACTION, "").replace(LEADING_MODIFIER, "").trim();
    if (text === before || !text) break;
  }

  // 还太长就截断（列表项放不下）
  const MAX = 14;
  if (text.length > MAX) text = text.slice(0, MAX);

  if (!text) return "新工作任务";

  // 按产物类型补一个动词后缀。已经带了动词就不重复加。
  for (const [pattern, suffix] of ARTIFACT_SUFFIX) {
    if (pattern.test(text)) {
      if (text.endsWith(suffix)) return text;
      return `${text}${suffix}`;
    }
  }
  return text;
}

/* ============================================================
 * 2. 进度计时文案
 * ============================================================ */

/**
 * 把毫秒数说成人话。
 *
 * **四档**，不是两档 —— 从上位源码的 i18n 表里读到原版的口径：
 * ```
 * infra_cot_working_dayHourMinSec  已处理 {s_day} 天 {s_hour} 小时 {s_minute} 分 {s_second} 秒
 * infra_cot_working_hourMinSec     已处理 {s_hour} 小时 {s_minute} 分 {s_second} 秒
 * infra_cot_working_minSec         已处理 {s_minute} 分 {s_second} 秒
 * infra_cot_working_sec            已处理 {s_second} 秒
 * ```
 * 规则是**只显示最高位那一档**：有天才报天，有小时只报「时/分/秒」，依次退。
 * 我最初只做了「分/秒」两档，跑两小时的录制会显示成「已处理 120 分 0 秒」。
 *
 * @param ms 已经过的毫秒数
 * @returns 时长片段，例如 `31 秒` / `2 分 35 秒` / `1 小时 2 分 3 秒`
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const day = Math.floor(total / 86400);
  const hour = Math.floor((total % 86400) / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  if (day > 0) return `${day} 天 ${hour} 小时 ${minute} 分 ${second} 秒`;
  if (hour > 0) return `${hour} 小时 ${minute} 分 ${second} 秒`;
  if (minute > 0) return `${minute} 分 ${second} 秒`;
  return `${second} 秒`;
}

/** 未结束时（拿不到结束时间）的占位文案，与上位一致。 */
export const ELAPSED_PLACEHOLDER = "共用时 —";

/**
 * 进度行的完整文案。
 *
 * @param task 任务
 * @param now 当前时间（调用方传入，便于测试）
 * @returns 例如 `已处理 31 秒`；任务结束后是 `共用时 3 分 41 秒`
 */
export function progressLabel(task: WorkTask, now: number): string {
  if (task.startedAt === null) return "";
  if (task.finishedAt !== null) {
    return `共用时 ${formatDuration(task.finishedAt - task.startedAt)}`;
  }
  if (task.stage === "awaiting") return ""; // 在等用户回答，不计时（原版此时不显示进度行）
  return `已处理 ${formatDuration(now - task.startedAt)}`;
}

/* ============================================================
 * 3. 澄清提问卡的推进
 * ============================================================ */

/**
 * 当前该问的问题。
 * @returns 没有问题、或已经问完时返回 null（调用方据此继续干活）
 */
export function currentQuestion(task: WorkTask): TaskQuestion | null {
  if (task.stage !== "awaiting") return null;
  return task.questions[task.questionIndex] ?? null;
}

/** 分页文案，例如 `1/3`。没有问题时返回空串。 */
export function questionProgress(task: WorkTask): string {
  const total = task.questions.length;
  if (total === 0) return "";
  return `${Math.min(task.questionIndex + 1, total)}/${total}`;
}

/**
 * 回答当前问题，推进到下一题。
 *
 * @param task 当前任务
 * @param answer 用户选的/填的答案（要记进对话流）
 * @param stepId 新步骤的 id（由调用方生成，避免这里依赖随机数）
 * @param now 当前时间
 * @returns 推进后的任务；若已是最后一题，stage 切回 `running`
 */
export function answerQuestion(task: WorkTask, answer: string, stepId: string, now: number): WorkTask {
  if (task.stage !== "awaiting") return task;
  const nextIndex = task.questionIndex + 1;
  const more = nextIndex < task.questions.length;
  const steps: TaskStep[] = [
    ...task.steps,
    { id: stepId, role: "user", text: answer, at: now },
  ];
  if (more) {
    return { ...task, steps, questionIndex: nextIndex };
  }
  return {
    ...task,
    steps,
    questionIndex: nextIndex,
    stage: "running",
    activity: "正在处理",
    // 从"等待"回到"干活"时重新开始计时，否则「已处理」里会算上用户思考的时间
    startedAt: now,
  };
}

/** 问题队列最多 3 题（原版实测 1/3 → 2/3，没有超过 3）。 */
export function acceptQuestions(list: TaskQuestion[]): TaskQuestion[] {
  return list.slice(0, MAX_QUESTIONS);
}

/* ============================================================
 * 4. 列表与命名
 * ============================================================ */

/** 左侧「最近」列表项的显示信息。 */
export type RecentRow = {
  id: string;
  title: string;
  /** 带「待确认」角标（原版在等用户回答时显示脉冲点 + 待确认）。 */
  pending: boolean;
  /** 已完成的任务显示时长。 */
  subtitle?: string;
};

/**
 * 把一个任务映射成左侧列表行。
 * @param task 任务
 * @returns 列表行
 */
export function toRecentRow(task: WorkTask): RecentRow {
  const duration =
    task.finishedAt !== null && task.startedAt !== null
      ? formatDuration(task.finishedAt - task.startedAt)
      : undefined;
  return {
    id: task.id,
    title: task.title,
    pending: task.stage === "awaiting",
    subtitle: duration,
  };
}

/** 生成一个步骤 id（不用渲染层的东西，主进程/测试里也能用）。 */
export function makeStepId(seq: number): string {
  return `s${seq}`;
}

/** 任务标题的字数口径（上位 `moa_comms_taskTitleLimit` =「任务标题，不超过16个字。」）。 */
export const TASK_TITLE_LIMIT = 16;

/**
 * 清洗模型起的标题。
 *
 * 模型很少只回一个干净的标题，实测常见的几种脏法都要处理：
 * 带引号/书名号、结尾带句号、前面写「标题：」、后面另起一行加解释。
 * 直接塞进列表会很难看。洗不出来就返回空串，调用方保留原标题。
 *
 * @param raw 模型输出
 * @returns 干净的标题；洗不出东西时返回空串
 */
export function cleanTitle(raw: string): string {
  let text = String(raw ?? "").trim();
  // 只取第一行（模型爱在后面加解释）
  text = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  // 去掉「标题：」这类前缀
  text = text.replace(/^(?:标题|任务标题|title)\s*[：:]\s*/i, "");
  // 去掉包裹的引号 / 书名号 / 括号
  text = text.replace(/^["'“”‘’《》「」【】()（）]+/, "").replace(/["'“”‘’《》「」【】()（）]+$/, "");
  // 去掉结尾标点
  text = text.replace(/[。．.!！?？~～\s]+$/, "");
  text = text.trim();
  if (!text) return "";
  // 超长截断到口径上限
  return text.length > TASK_TITLE_LIMIT ? text.slice(0, TASK_TITLE_LIMIT) : text;
}

/* ───────────────────────── 恢复一步（§177） ───────────────────────── */

/**
 * 步骤上那一句额外说明的字数上限（§177）。
 *
 * 留痕是**一行**：磁盘上的东西不可信，超长的直接截断，
 * 而不是把一整段塞进界面。
 */
export const STEP_NOTE_LIMIT = 200;

/**
 * 收窄落盘的 `usage`（C5）。
 *
 * 磁盘上的东西不可信：只认**数字**，别的（字符串、NaN、对象）一律丢掉 ——
 * 编不出一个"看起来像用量"的值（那比没有更坏：界面会显示一个假的真值）。
 *
 * @param raw 落盘的那一项
 * @returns 干净的用量；一个数字都没有时返回 null
 */
export function usageOf(raw: unknown): StepUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  /*
   * 2026-10-14：把 provider 的**缓存明细**与**这一轮的实测耗时**也接住（`runTurn` 现在会带回来）。
   * 少了它们，界面上「缓存命中 / 缓存读取 / 吞吐量」永远是空的 —— 而那是"我们没接"，不是"没有"。
   * 判据不变：只认数字，坏的丢掉。
   */
  const keys = ["inputTokens", "outputTokens", "noCacheTokens", "cacheReadTokens", "cacheWriteTokens", "elapsedMs"] as const;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = num(o[k]);
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? (out as StepUsage) : null;
}

/**
 * 从落盘的（不可信）数据里恢复**一步**（§177）。
 *
 * ## 为什么把它从 `store.ts` 里抽出来
 *
 * 原来这段映射写在 `normalizeTask` 里，是**私有内联**的 —— 于是它**没法单测**，
 * 而它恰恰是最容易漏字段的地方（§176 发现了 `tools` 被丢，§177 发现 `note` 也被丢）。
 * 抽成纯函数之后，`TaskStep` 声明的每个字段都能有断言守着。
 *
 * ## 规矩
 *
 * 磁盘上的东西一律当不可信处理：**逐项类型检查**，坏的丢掉而不是整条失败；
 * 缺 id 就按序号补一个（历史数据里可能真没有）。
 *
 * @param raw 落盘的一条
 * @param index 它在 steps 里的序号（补 id 用）
 * @returns 干净的步骤
 */
export function normalizeStep(raw: unknown, index: number): TaskStep {
  const s = (raw ?? {}) as Record<string, unknown>;
  const note = typeof s.note === "string" ? s.note.trim().slice(0, STEP_NOTE_LIMIT) : "";
  const tools = normalizeToolTraces(s.tools);
  const attachments = normalizeAttachments(s.attachments);
  // 先算一次再判（分两次调用的话 TS 收不窄，会变成 `{…} | null`）
  const usage = usageOf(s.usage);
  return {
    id: typeof s.id === "string" && s.id ? s.id : makeStepId(index),
    role: s.role === "user" ? "user" : "assistant",
    text: typeof s.text === "string" ? s.text : "",
    at: typeof s.at === "number" ? s.at : 0,
    ...(typeof s.cost === "number" ? { cost: s.cost } : {}),
    ...(usage ? { usage } : {}),
    // 这两项要一起恢复：askedWith 是「重新生成」的依据，rating 是评价留痕
    ...(typeof s.askedWith === "string" ? { askedWith: s.askedWith } : {}),
    ...(s.rating === "up" || s.rating === "down" ? { rating: s.rating as "up" | "down" } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    /*
     * ⚠️ `note` 也要恢复（§177）：它是**"更早的对话已压缩为摘要"**那条。
     *
     * §149 写这条时说得明明白白："挂在步骤上而不是飘一个 toast ——
     * 飘提示刷新就没了，回头翻这段对话会不知道当时上下文被压过。"
     * 而恢复时原来把它丢了 —— **等于又变回了"刷新就没"**。
     */
    ...(note ? { note } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

/**
 * G2：附件元数据收窄（磁盘内容不可信）。
 *
 * 只认五个字段都合法的条目；`data`/base64 一律**不收** —— 步骤里不该有正文，
 * 旧版本若误写过也会在恢复时被丢掉。
 */
export function normalizeAttachments(raw: unknown): SavedAttachmentMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedAttachmentMeta[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.path !== "string" || !a.path || a.path.length > 1000) continue;
    if (typeof a.mediaType !== "string" || !a.mediaType) continue;
    if (typeof a.name !== "string" || !a.name) continue;
    if (typeof a.sha256 !== "string") continue;
    if (typeof a.bytes !== "number" || !Number.isFinite(a.bytes) || a.bytes < 0) continue;
    out.push({
      path: a.path,
      mediaType: a.mediaType,
      bytes: a.bytes,
      sha256: a.sha256,
      name: a.name.slice(0, 200),
    });
  }
  return out;
}

/* ────────────────── 恢复产物 / 澄清卡（§179） ────────────────── */

/**
 * 从落盘的（不可信）数据里恢复产物（§179）。
 *
 * ## 为什么必须收窄
 *
 * 原来这里是一句 `t.artifacts as Artifact[]` —— **裸断言**。
 * 产物卡要按 `kind` 决定怎么显示、按 `status` 决定显示哪个中间态，
 * 一个 `kind` 不认识的产物会让卡片渲染出空白或直接报错。
 *
 * ## 规矩
 *
 * - 缺 `id` 或 `kind` 不认识的 → **丢掉**（认不出来的东西没法正确显示）；
 * - `kind` 认不认识用 `ARTIFACT_FORMATS` 的键来判断 —— **不另写一张表**，
 *   以后加了新的产物类型这里自动跟上（这是"一处实现"在数据层的用法）。
 *
 * @param raw 落盘的数组
 * @returns 干净的产物列表
 */
export function normalizeArtifacts(raw: unknown): Artifact[] {
  if (!Array.isArray(raw)) return [];
  const kinds = Object.keys(ARTIFACT_FORMATS) as ArtifactKind[];
  const out: Artifact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const id = typeof a.id === "string" ? a.id : "";
    const kind = a.kind as ArtifactKind;
    if (!id || !kinds.includes(kind)) continue;
    out.push({
      id,
      taskId: typeof a.taskId === "string" ? a.taskId : "",
      title: typeof a.title === "string" ? a.title : "",
      kind,
      createdAt: typeof a.createdAt === "number" && Number.isFinite(a.createdAt) ? a.createdAt : 0,
      ...(typeof a.stepId === "string" ? { stepId: a.stepId } : {}),
      ...(a.status === "generating" || a.status === "generated" || a.status === "failed"
        ? { status: a.status }
        : {}),
      ...(typeof a.content === "string" ? { content: a.content } : {}),
      ...(typeof a.filePath === "string" ? { filePath: a.filePath } : {}),
      ...(typeof a.bytes === "number" && Number.isFinite(a.bytes) ? { bytes: a.bytes } : {}),
      ...(typeof a.note === "string" ? { note: a.note } : {}),
    });
  }
  return out;
}

/**
 * 从落盘的（不可信）数据里恢复澄清卡（§179）。
 *
 * ## 这条修的是**一个真崩溃**
 *
 * 界面上是 `question.options.map(...)` ——
 * 落盘的 `options` 丢了或不是数组时，**那一整段对话直接打不开**（渲染抛异常）。
 *
 * 所以口径定得严一点：
 *
 * - 没有 `id` → 丢掉；
 * - 选项里**一个合法的都没有** → **整张卡丢掉**（一张没有选项的选择卡是死路，
 *   不如不显示；原来会给用户一个点不动的卡片）；
 * - 超过 `MAX_QUESTIONS` 的截断（口径同创建时）。
 *
 * @param raw 落盘的数组
 * @returns 干净的澄清卡
 */
export function normalizeQuestions(raw: unknown): TaskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskQuestion[] = [];
  for (const item of raw) {
    if (out.length >= MAX_QUESTIONS) break;
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const id = typeof q.id === "string" ? q.id : "";
    if (!id) continue;
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
      .map((o) => ({
        label: typeof o.label === "string" ? o.label : "",
        hint: typeof o.hint === "string" ? o.hint : "",
      }))
      .filter((o) => o.label.trim().length > 0);
    if (options.length === 0) continue;
    out.push({ id, text: typeof q.text === "string" ? q.text : "", options });
  }
  return out;
}

/* ============================================================
 * 5. 任务列表与 id
 * ============================================================ */

/** 已进入"最近的"任务（用于左侧列表，最新的在前）。 */
export function upsertTask(tasks: WorkTask[], patch: WorkTask): WorkTask[] {
  const index = tasks.findIndex((t) => t.id === patch.id);
  if (index === -1) return [patch, ...tasks];
  const next = [...tasks];
  next[index] = patch;
  return next;
}

/** 取当前任务（找不到时用传入的兜底，避免闭包里拿到旧对象）。 */
export function current(tasks: WorkTask[], id: string): WorkTask {
  return tasks.find((t) => t.id === id) ?? tasks[0];
}

/** 生成一个步骤 id（不用渲染层的东西，主进程/测试里也能用）。 */
export function nextStepId(): string {
  return makeStepId(Date.now());
}
/**
 * 被中断的回合，该"继续"什么（Phase 12.2 的桌面端）。
 *
 * ## 判据来自引擎，不在这一层再判一次（审计 P139 / P211）
 *
 * 「这一轮被打断了吗」只有一条判据（**有请求、没有收尾记录**），它住在
 * `engine/core/recovery.ts`（`interruptedTurns` / `interruptedFromStage`）。
 * 桌面端恢复任务时用那个判据算出一个**真值** `task.interrupted` 落盘
 * （`taskPersist.normalizeTask`），这里只读它。
 *
 * 原来这里是 `stage === "failed"` 加 `activity` 里匹配「被中断」三个字 ——
 * 那是把**给人看的说明**当判据用，代价很具体：provider 报一句「连接被中断」
 * （说的是网络断了）也会长出一颗「继续」按钮，点下去又花一次钱。
 *
 * ## 两条前提（都要，缺一个就不给按钮）
 *
 * · **`stage === "failed"`**：跑着/等着/跑完的任务没有"要继续"这回事。
 * · **必须能找到那句用户原话**：找不到就不给按钮（给一个按下去什么都不会发生的
 *   按钮，比不给更糟）。历史里一定有 user 步骤，所以找不到基本意味着数据本身有问题。
 *
 * @param task 任务（**不可信**：字段可能来自磁盘）
 * @returns 上一次用户说的那句**原话**；没有可继续的 → `null`
 */
export function continueTargetOf(task: {
  stage: string;
  activity?: string;
  /** 恢复时记下的真值（新盘都有；旧盘没有这个字段）。 */
  interrupted?: boolean;
  steps: ReadonlyArray<{ role: string; text: string }>;
}): string | null {
  if (task.stage !== "failed") return null;
  if (!wasInterrupted(task)) return null;
  for (let i = task.steps.length - 1; i >= 0; i -= 1) {
    const step = task.steps[i];
    if (step?.role === "user" && step.text.trim()) return step.text;
  }
  return null;
}

/**
 * 这个任务里那一轮是不是被打断的。
 *
 * 真值优先（`interrupted`）；只有**旧盘**（这次修复之前写下的 `tasks.json`）
 * 才回落到那句说明 —— 那时它确实是唯一的痕迹，如实认一次，但不扩散到新数据。
 *
 * @param task 任务
 * @returns 是被打断的那种失败吗
 */
function wasInterrupted(task: { interrupted?: boolean; activity?: string }): boolean {
  if (typeof task.interrupted === "boolean") return task.interrupted;
  return (task.activity ?? "").includes(INTERRUPTED_NOTE);
}
