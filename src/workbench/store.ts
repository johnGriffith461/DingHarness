import { create, type StoreApi } from "zustand";
import type { AttachmentDraftWire, ChatPart, SavedAttachmentMeta, ShellBridge } from "@shared/ipc";
import { runToolOnce } from "../ai/aiClient";
import {
  buildAskPrompt,
  buildCodingAskPrompt,
  buildCodingDoPrompt,
  buildDoPrompt,
  describeAnswer,
  parseAskReply,
} from "./agent";
import { extractArtifacts } from "./artifact";
import {
  rejectedLine,
  type ToolTrace,
} from "@shared/agentTools";
import { taskSessionId } from "@engine/core/events";
import { fabricatedCost } from "@shared/cost";
import { branchFrom, editedBranchFrom, planRewind, resolveRewindTarget } from "./checkpoint";
import { readConfirmMode } from "./confirmMode";
import { verificationMessage } from "./verifyContinue";
import {
  buildApprovalResultMessage,
  hasPendingApproval,
  markResumeFired,
  takeResumeBudget,
  type ApprovalOutcome,
} from "./approvalResume";
import { readPlanMode, savePlanMode } from "./planMode";
import { isPlanTransitionAllowed, planApprovalError, truncatePlan } from "@engine/runtime/planMode";
import { pickSuggestions, HOME_MODE_KEY, parseHomeMode, suggestionsFor, type HomeMode } from "./copy";
import { rememberAlwaysAllow } from "./permissionRules";
import {
  restoreTasks as restoreTasksIn,
  startTaskPersistence as startTaskPersistenceIn,
} from "./taskPersist";
import {
  abortRunning,
  answerTurn,
  compactNow,
  isSessionRunning,
  nextStep,
  persistArtifacts,
  refineTitle,
  runStream,
  verifyAfterTurn,
  continueWithUserMessage,
  appendStepNote,
  finishNoteOf,
} from "./taskRuntime";
import {
  answerQuestion,
  autoTaskTitle,
  current,
  makeStepId,
  taskMode,
  upsertTask,
  type TaskOption,
  type TaskStep,
  type WorkTask,
} from "./task";

/**
 * 工作台状态（阶段 10）。
 *
 * 这里把"任务"接到**真实的 AI 通道**上 —— 不是假数据。流程跟原版一致：
 *   发一句话 → 自动起标题 → 第 1 段（判断要不要问）→ 有问题就弹提问卡 →
 *   用户答完 → 第 2 段（真的干活）→ 完成
 *
 * 一个刻意的取舍：**提问卡不是硬编码的**。要不要问、问什么、给哪些选项，
 * 都由模型按 `buildAskPrompt` 里的约定现场产出 —— 原版也是这样
 * （同一个任务每次给的选项都不一样，实测两次就换了一批）。
 */

/**
 * G2：把这一轮的附件草稿写进**当前会话目录**，回元数据。
 *
 * 这一步必须在拿得到任务 id 之后做（新建任务时 id 是刚生成的），
 * 否则附件会落到 `draft/` 里、重启后按会话目录校验就读不到。
 * 单个失败不阻塞发送：内容已经在 `parts` 里，元数据只是"重启后还能看"的凭据。
 */
async function persistAttachmentDrafts(
  sessionId: string,
  drafts: AttachmentDraftWire[] | undefined,
): Promise<SavedAttachmentMeta[]> {
  if (!drafts?.length) return [];
  const bridge = (globalThis as unknown as { shell?: ShellBridge }).shell;
  const out: SavedAttachmentMeta[] = [];
  for (const draft of drafts) {
    try {
      const got = await bridge?.attachments?.save?.({
        sessionId,
        name: draft.name,
        mediaType: draft.mediaType,
        data: draft.data,
      });
      if (!got?.ok) continue;
      out.push({
        path: got.path,
        mediaType: got.mediaType,
        bytes: got.bytes,
        sha256: got.sha256,
        name: got.name,
      });
    } catch {
      /* 落盘失败不影响发送 */
    }
  }
  return out;
}

/** 工作台里的一个"页面"。 */
export type WorkbenchView =
  | "home"
  | "task"
  | "scheduled"
  | "plugins"
  | "phone"
  | "threads"
  | "doc"
  | "center"
  | "reader"
  | "agent"
  | "coding"
  | "image"
  | "video"
  /* V6-2c/2d：用量与请求追踪（只读派生数据，见 InsightsPage） */
  | "usage"
  /* V6-2i/4d：两轴权限矩阵（只读展示内核判定，见 PermissionMatrixPage） */
  | "permissions"
  /* V6-2l：多 agent 工作流（泳道与断点续跑；运行在 CLI，见 WorkflowPage） */
  | "workflow"
  /* D2：工具面板（注册表里的工具与元数据） */
  | "tools"
  /* F4：终端（只读回放本会话的命令） */
  | "terminal";

export type WorkbenchState = {
  view: WorkbenchView;
  tasks: WorkTask[];
  activeTaskId: string | null;
  /** 正在跑的请求（用于中止）。 */
  runningRequestId: string | null;
  /** 首页推荐卡（原版会给，且内容会变）。 */
  suggestions: string[];
  /** 首页工作模式（D02）：编码 / 办公；推荐卡跟着它走。 */
  homeMode: HomeMode;
  /** 切换工作模式（同时换一批推荐卡，并持久化到 localStorage）。 */
  setHomeMode: (mode: HomeMode) => void;
  /** 重新抽一批推荐卡（进首页时调）。 */
  refreshSuggestions: () => void;
  /**
   * 画布面板是否展开。
   *
   * 原版的形态是**画布开在对话旁边**（HANDOFF §18.2），不是占满中间：
   * 对话驱动生成，画布展示产物。所以这里把画布做成一侧可开合的产物面板，
   * 而不是像我们早先那样把它当成主界面。
   */
  canvasOpen: boolean;
  /**
   * 左侧导航栏是否收起（2026-10-15，M0 工单 3）。
   *
   * 这条**兑现的是工单里"能快的就实现"那一类**：几个页面（手机遥控电脑 / 插件·技能·伙伴 /
   * 定时任务 / 历史对话 / 任务视图 / 用量与追踪 / 权限矩阵 / 工作流）的头部各自摆过同一颗「打开/收起左侧栏」，
   * 而它一直是 `disabled` —— 后来收成一个 `NavCollapseButton`，一处实现几处受益。
   *
   * ⚠️ **清单要照实际引用点写**（2026-10-16 审计 P193）：
   * 这里原来声称「六个页面」共用它，与实际不符 —— 云盘整页早就拆掉了，
   * 而**任务中心从来没有**这颗按钮；真正引用它的是
   * `PhonePage` / `PluginsPage` / `ScheduledPage` / `ThreadListPage` / `TaskView` /
   * `InsightsPage`（用量与追踪）/ `PermissionMatrixPage`（权限矩阵）/ `WorkflowPage`（工作流）八处
   * （`grep NavCollapseButton src/workbench`）。假清单的代价不只是读着不对：
   * 它把**真实缺口**盖住了 —— 首页 / 任务中心 / 文档 / 阅读器 / 智能体 / 编程 / 图片 / 视频都**没有**它
   * （收起后在那几页里回不去，只剩快捷键那一套）。
   * 那条缺口（审计 P187）另案处理；这里至少不许再声称"都有"。
   *
   * ⚠️ **收起后怎么再打开**：那颗按钮在**页面头部**（主区里），不在左栏里 ——
   * 所以左栏收成 0 宽之后它照样看得见、点得到（不需要再挂一颗浮标）。
   * 这与右栏摘要面板不同：那个的展开入口是右缘浮标，因为它连头部一起收掉了。
   *
   * 这条状态**跨重启记住**（2026-10-16 审计 P191）：落盘走 `appSettings`（主进程原子写），
   * 两边由 `appSettings.startNavCollapsedSync` 接起来（接线在 `NavSidebar.tsx`）——
   * 所以这里仍是内存初值，别在这里自己读写盘。
   */
  navCollapsed: boolean;
  /** 收起 / 展开左栏。 */
  toggleNav: () => void;
  /**
   * 悬浮助手窗是否打开。
   *
   * 挂在应用级而不是任务视图里：云盘的文件行右键也有「问问豆包」，
   * 它不该切到任务视图才能用。`floatSeed` 是打开时预填/直接发送的问题。
   */
  floatOpen: boolean;
  floatSeed: string;
  /**
   * 待填入定时任务表单的草稿（任务顶栏的 ⏰ 用它把当前任务变成定时任务）。
   *
   * 「这个任务想每天跑一次」是很常见的下一步，而原来那条路要用户自己去定时任务页
   * 把标题和内容重新打一遍。这里只传一段草稿过去，**建不建仍由用户在表单里决定** ——
   * 点一下就直接建出一个定时任务会让人意外。
   */
  scheduleDraft: { title: string; prompt: string } | null;

  /**
   * 「创作同款」这类按钮要**把一句话交到主输入区**（§159）。
   *
   * 照 `scheduleDraft` 的范式做：**设置 + 切视图**，消费方 `take` 一次就清 ——
   * 这样"谁来清空"是明确的，不会出现"填进去又莫名其妙一直在那儿"。
   */
  composerDraft: string | null;
  /**
   * 输入区的草稿，**按视图各存一份**（2026-10-16，审计 P84）。
   *
   * 原来草稿是 `Composer` 的组件内 state，而 `Workbench` 按 view **整体换组件** ——
   * 于是"在输入框里写着东西，按 Ctrl+N / 点左栏切个页"回来一看，**整段话没了**。
   * 这和 `composerDraft`（一次性"创作同款"，取出即清）不是一回事：这是**用户正在写的东西**，
   * 要一直留着，直到他自己发出去或清掉。
   *
   * 按视图分开存：首页那份不该跑到对话里那句输入框去（两处的用途不同：
   * 一个"开新任务"、一个"在这段对话里接着说"）。
   */
  composerTexts: Record<string, string>;
  /** 记下某个视图输入区的草稿（逐字，不做 trim —— 用户打到一半的空格也是他的内容）。 */
  setComposerText: (view: string, text: string) => void;
  /** 带着草稿跳到定时任务页。 */
  scheduleFromTask: (title: string, prompt: string) => void;
  /** 把一句话交到主输入区（§159「创作同款」）。 */
  setComposerDraft: (text: string) => void;
  /** 取走那句草稿（取一次就清）。 */
  takeComposerDraft: () => string | null;
  /**
   * 「插件页要直接进管理子页」这个意图（2026-10-14）。
   *
   * 技能面板的命令区里有「技能管理」（本体口径）—— 它该**直接进**插件页的管理子页，
   * 而不是先落到市场页让用户再点一次。但那个子页模式是 `PluginsPage` 的**局部 state**，
   * 从命令区喊不动它 —— 于是走这条"放下意图、由插件页取出即清"的通道
   * （与 `composerDraft` 同一套做法：谁取出谁负责清，避免反复触发）。
   */
  pluginsIntent: "manage" | null;
  setPluginsIntent: (intent: "manage" | null) => void;
  takePluginsIntent: () => "manage" | null;
  takeScheduleDraft: () => { title: string; prompt: string } | null;

  setView: (view: WorkbenchView) => void;
  toggleCanvas: () => void;
  /**
   * 明确地把画布设为开/关（2026-10-14）。
   *
   * 为什么不能只有 `toggleCanvas`：技能面板点「创建画布」的语义是**打开**，
   * 用 toggle 的话"已经开着时再点"会把它关掉 —— 用户按的是"创建"，看到的却是"消失"。
   */
  setCanvasOpen: (open: boolean) => void;
  /** 打开悬浮助手窗；给了 `seed` 就带着这个问题打开。 */
  openFloat: (seed?: string) => void;
  closeFloat: () => void;
  /** 新建一个任务并立刻开始跑（对应原版"发消息或创建任务"）。 */
  createTask: (
    message: string,
    options?: { background?: boolean; material?: string; parts?: ChatPart[]; attachmentDrafts?: AttachmentDraftWire[] },
  ) => Promise<string | undefined>;
  /** 在已有对话里继续说一句（§147）—— 与 `createTask` 的区别是带上历史。 */
  sendInTask: (
    taskId: string,
    message: string,
    options?: { material?: string; parts?: ChatPart[]; attachmentDrafts?: AttachmentDraftWire[] },
  ) => Promise<void>;
  /** G1：编辑计划面板里的文本（只改草稿，不写盘）。 */
  setPlanText: (taskId: string, text: string) => void;
  /**
   * G1：批准计划 —— 只在 `awaiting_approval` 时可用。
   *
   * 顺序是"先落盘，再执行"：写失败也继续执行（面板显示"未落盘"），
   * 但状态机不允许从 `idle` 跳过计划直接进入 `executing`。
   */
  approvePlan: (taskId: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  /** G1：放弃计划 —— 回 `idle`、不写盘、工具面恢复。 */
  abandonPlan: (taskId: string) => void;
  /**
   * 手动压缩当前对话（B2 的 `/compact`）。
   * 与自动压缩同一条路径；没有更早内容/摘要失败时返回可读错误。
   */
  compactActive: () => Promise<{ ok: boolean; older?: number; error?: string }>;
  /**
   * 回到某一步并从那里重来（§151）。
   *
   * ⚠️ **不撤销已发生的动作**（记忆、画布、定时任务、产物都还在）——
   * 回退改的是这段对话，不是世界。
   */
  /**
   * 回到某一步（之后的轮次丢掉）。
   *
   * ⚠️ 返回**真的成没成**（2026-10-16，审计 P86）：原来是 `Promise<void>`，
   * 而解析不到可回退的目标时函数里直接 `return` —— 调用方（那颗按钮）于是
   * 照着旧样说"已回到这一步"，**实际什么都没发生**。回执必须先知道结果。
   */
  rewindTask: (taskId: string, stepId: string) => Promise<boolean>;
  /** 从某一步分叉成一段新对话（§151）。 */
  branchTask: (taskId: string, stepId: string) => void;
  /**
   * C4：编辑一条**用户消息**并重发。
   * 从这条之前 fork 出一段新对话，原对话一个字不动；取消 = 零写入。
   */
  editAndResend: (taskId: string, stepId: string, newText: string) => Promise<boolean>;
  /** 回答当前澄清问题。 */
  answer: (option?: TaskOption, custom?: string) => Promise<void>;
  /** 打开已有任务。 */
  openTask: (id: string) => void;
  /** 重命名任务（实机：任务标题可点，后面带个 ›）。 */
  renameTask: (id: string, title: string) => void;
  /** 移除任务（从列表里去掉；产物文件留在磁盘上不动）。 */
  dropTask: (id: string) => void;
  /**
   * 重新生成某条 AI 回复（用当初**实际发出去的内容**再问一遍）。
   *
   * @param stepId 要替换的那条回复
   */
  regenerate: (taskId: string, stepId: string) => Promise<void>;
  /** 给一条回复打分（有帮助 / 没帮助）。 */
  rate: (stepId: string, rating: "up" | "down") => void;
  /**
   * 放行/拒绝一次被审批闸门拦下的工具调用（§144）。
   *
   * @param stepId 哪一步
   * @param toolCallId 哪一次调用（一次回复里可能有多**次**）
   * @param approve true = 允许并执行；false = 拒绝（只留痕，不动磁盘）
   */
  resolveTool: (
    taskId: string,
    stepId: string,
    toolCallId: string,
    approve: boolean,
    /** `remember=true` = 同时记一条「总是允许」规则（U03 的按钮走这条）。 */
    opts?: { remember?: boolean },
  ) => Promise<void>;
  /**
   * P0-04：执行任务上那份待验证计划（用户在卡片上点「运行验证」）。
   *
   * 点击本身就是批准 —— 走的仍是 `run_command` 那条通道，不另开一条执行路径。
   */
  runVerification: (taskId: string) => Promise<void>;
  /** P0-04：用户跳过验证（任务收尾，并如实留一句"用户跳过验证"）。 */
  skipVerification: (taskId: string) => void;
  /**
   * P0-05：一次批准/拒绝这一 step 里**所有**待批项，并且只续跑一次。
   *
   * 顺序执行（同一个 turn 里的多个写动作不能并发落盘），全部完成后才回注。
   */
  resolveAllTools: (taskId: string, stepId: string, approve: boolean) => Promise<number>;
  /** 生成整段对话的 Markdown（分享/导出用）。 */
  transcript: () => string;
  /**
   * 中止正在跑的轮次。
   *
   * @param taskId 只停**这一段对话**的轮次（界面上的「停止」就是这个语义）；
   *               不给就停掉所有在跑的轮次（2026-10-16 审计 P46：句柄按会话/轮次持有，
   *               原来是一个单值句柄，同会话并发两轮时「停止」会**打错对象**）
   */
  abort: (taskId?: string) => void;
};

/**
 * 交给 `taskRuntime` / `taskPersist` 的那一小块 store 能力。
 *
 * 那两个模块**只**用 `import type` 引这个类型（编译后完全擦除），运行期的读写靠参数注入 ——
 * 于是"store ↔ 运行时"这个环在**结构上**不可能成立，而不是靠"约定别成环"。
 * 本仓同一手法的先例：`src/workbench/scheduleStore.ts` 的 `execute(id, get, set)`。
 *
 * 类型直接引 zustand 的 `StoreApi`：`setState` 是重载（`replace: true` 那条），自己写会窄。
 */
export type StorePort = {
  getState: () => WorkbenchState;
  setState: StoreApi<WorkbenchState>["setState"];
  subscribe: StoreApi<WorkbenchState>["subscribe"];
};

/** ⚠️ 用箭头包一层：`{ getState: useWorkbenchStore.getState }` 会在模块初始化期取值，早于 create() 就炸。 */
const port: StorePort = {
  getState: () => useWorkbenchStore.getState(),
  setState: (partial) => useWorkbenchStore.setState(partial),
  subscribe: (listener) => useWorkbenchStore.subscribe(listener),
};

let seq = 0;
const nextId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

/**
 * 正在处置的审批（P48）：键是 `任务 id / 调用 id`。
 *
 * 放模块级而不是 state 里：它只表达"这一刻有没有同一次调用在飞"，
 * 不该触发任何重渲染（界面那边有自己的禁用态）。
 */
const resolvingTools = new Set<string>();

/**
 * 读上次选的工作模式（D02）。
 *
 * `localStorage` 在测试环境/无痕模式下可能直接抛 —— 读不到就当 `office`，
 * 这是"默认值"而不是"错误"：模式只影响首页展示。
 */
function readHomeMode(): HomeMode {
  try {
    return parseHomeMode(localStorage.getItem(HOME_MODE_KEY));
  } catch {
    return "office";
  }
}

/**
 * P0-05：这一 step 的待批项全部处置完之后，把结果送回模型并继续。
 *
 * 三道闸：
 * 1. **还有 pending** → 不续（用户在批量处理中间）；
 * 2. 同一批**只续一次**（并发点第二下不会再发一轮）；
 * 3. 同一 step **最多续 3 次**（模型反复要审批时停下来说明）。
 */
async function maybeResumeAfterApproval(port: StorePort, taskId: string, stepId: string): Promise<void> {
  const snapshot = useWorkbenchStore.getState();
  const step = snapshot.tasks.find((t) => t.id === taskId)?.steps.find((x) => x.id === stepId);
  if (!step) return;
  const traces = step.tools ?? [];
  if (hasPendingApproval(traces)) return;
  if (!markResumeFired(taskId, stepId)) return;
  if (!takeResumeBudget(taskId, stepId)) {
    appendStepNote(port, taskId, "同一待批步骤已续跑 3 次，已停止（请检查是否卡在同一个动作上）");
    return;
  }
  const outcomes: ApprovalOutcome[] = traces
    .filter((t) => t.pending !== true)
    .map((t) => ({
      ...(t.toolCallId ? { toolCallId: t.toolCallId } : {}),
      name: t.name,
      ...(t.rejected ? { rejected: true as const } : {}),
      ok: t.ok,
      ...(t.output !== undefined ? { output: t.output } : {}),
      ...(t.error ? { error: t.error } : {}),
    }));
  if (!outcomes.length) return;
  try {
    /* ⚠️ 续跑失败（例如没有桥/网络）不能把审批结果本身判成失败：只留一句话 */
    await continueWithUserMessage(port, taskId, buildApprovalResultMessage(outcomes));
  } catch (error) {
    appendStepNote(port, taskId, `续跑失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  view: "home",
  tasks: [],
  activeTaskId: null,
  runningRequestId: null,
  /*
   * 画布默认**收起**。
   *
   * 原版首页没有画布 —— 它是任务产出物之后的展示处，不是常驻界面。
   * 而且实测开着的时候它把任务区挤到一半宽，对话读起来很难受。
   */
  canvasOpen: false,
  toggleCanvas: () => set((s) => ({ canvasOpen: !s.canvasOpen })),
  setCanvasOpen: (open) => set((s) => (s.canvasOpen === open ? s : { canvasOpen: open })),

  navCollapsed: false,
  toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),

  floatOpen: false,
  floatSeed: "",
  openFloat: (seed) => set({ floatOpen: true, floatSeed: seed ?? "" }),
  closeFloat: () => set({ floatOpen: false, floatSeed: "" }),

  composerDraft: null,
  composerTexts: {},
  setComposerText: (view, text) =>
    set((s) => ({ composerTexts: { ...s.composerTexts, [view]: text } })),
  pluginsIntent: null,
  scheduleDraft: null,
  scheduleFromTask: (title, prompt) => {
    set({ scheduleDraft: { title, prompt }, view: "scheduled" });
  },
  takeScheduleDraft: () => {
    const draft = get().scheduleDraft;
    if (draft) set({ scheduleDraft: null });
    return draft;
  },
  /** 把一句话交到主输入区（§159「创作同款」）。设置的同时切到首页。 */
  setComposerDraft: (text) => {
    set({ composerDraft: text, view: "home" });
  },
  setPluginsIntent: (intent) => set({ pluginsIntent: intent }),
  takePluginsIntent: () => {
    const intent = get().pluginsIntent;
    if (intent) set({ pluginsIntent: null });
    return intent;
  },
  takeComposerDraft: () => {
    const draft = get().composerDraft;
    if (draft) set({ composerDraft: null });
    return draft;
  },
  // 实机的推荐卡**会变**；从池子里抽四条，每次进首页重新抽
  homeMode: readHomeMode(),
  suggestions: pickSuggestions(suggestionsFor(readHomeMode())),

  setView: (view) => {
    set({ view });
    // 回首页就重抽推荐卡（实机每次进去都不一样）
    if (view === "home") get().refreshSuggestions();
  },

  /**
   * 切视图；回到首页时**重新抽一批推荐卡**。
   *
   * 实机那几条每次进去都不一样（三次遍历看到三组不同的）。写死四条会露馅，
   * 而"只在启动时抽一次"也不够 —— 用户来回切两次就该看出来是固定的了。
   */
  refreshSuggestions: () => set((s) => ({ suggestions: pickSuggestions(suggestionsFor(s.homeMode)) })),

  /**
   * 切换工作模式：换池子、立刻重抽，并记住。
   *
   * 持久化放 `localStorage`（与画布的 `compact-keep-tokens` 同一做法）：
   * 它只影响首页展示，不该为它加一条 IPC 契约（那会让 `shared/ipc.ts` 的冻结面变大）。
   * 读不到/写不进都不影响功能 —— 下次回落到 `office`。
   */
  setHomeMode: (mode) => {
    try {
      localStorage.setItem(HOME_MODE_KEY, mode);
    } catch {
      /* 无痕模式/测试环境：模式只在这次会话里有效，不影响功能 */
    }
    set({ homeMode: mode, suggestions: pickSuggestions(suggestionsFor(mode)) });
  },

  /**
   * 打开一段已有对话。
   *
   * ⚠️ 顺手记下**访问时刻**（2026-10-16 审计 P266）：任务中心的「最近访问」
   * 原来按 `createdAt` 排（那一栏显示的其实是"最近创建"）。这是"访问"这个动作
   * 唯一的两处落点之一（另一处是 `sendInTask`），所以更新放在这里最省事也最准。
   */
  openTask: (id) =>
    set((s) => ({
      view: "task",
      activeTaskId: id,
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, openedAt: Date.now() } : t)),
    })),

  renameTask: (id, title) => {
    const clean = title.trim().slice(0, 60);
    if (!clean) return;
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, title: clean } : t)) }));
  },

  dropTask: (id) => {
    /*
     * 只从列表里去掉，**不动磁盘上的产物** ——
     * 产物是用户的东西，"移出一个任务列表"不该顺手把文件也删了。
     */
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== id),
      activeTaskId: s.activeTaskId === id ? null : s.activeTaskId,
      view: s.activeTaskId === id ? "home" : s.view,
    }));
  },

  regenerate: async (taskId, stepId) => {
    /*
     * ⚠️ **必须按任务找**（§151 顺手修的 bug）。
     *
     * 步骤 id 是**按序号**生成的（`makeStepId(n)` → `s1`/`s2`…），所以**两段对话会撞 id**。
     * 原来这里是"在全部任务里按 id 找第一个" —— 只要有第二段对话，
     * 点「重新生成」就可能**改到另一段对话上去**（而当前这段看起来毫无反应）。
     */
    const state = get();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const step = task.steps.find((s) => s.id === stepId);
    if (!step || step.role !== "assistant") return;
    // 老数据没有 askedWith（那一版没存），退回到"上一条用户消息"
    const index = task.steps.findIndex((s) => s.id === stepId);
    const fallback = [...task.steps.slice(0, index)].reverse().find((s) => s.role === "user")?.text ?? "";
    const user = step.askedWith ?? fallback;
    if (!user) return;

    const patch = (next: Partial<WorkTask>) =>
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === task.id ? { ...t, ...next } : t)) }));

    /*
     * 系统提示词按**当前任务**重建（和第一次一样），但用户内容用当初存下来的原文 ——
     * 这样"重新生成"才是同一次提问的重跑，而不是"用现在的上下文又问一遍"。
     */
    const background = task.steps.filter((s) => s.role === "user" && s.text.includes(" → ")).map((s) => s.text);
    const { system } = taskMode(task) === "coding"
      ? buildCodingDoPrompt(task.brief, background, task.material)
      : buildDoPrompt(task.brief, background, task.material);
    const raw = await runStream(port, user, system, patch, [], task.id);
    const ask = parseAskReply(raw.text);
    const { text, artifacts } = extractArtifacts(
      ask.text,
      task.id,
      Date.now(),
      (i) => `${task.id}-r${Date.now()}-${i + 1}`,
      stepId,
    );
    const fresh: TaskStep = {
      id: stepId,
      role: "assistant",
      text: text || (artifacts.length ? "产物已生成，见右侧「对话产物」。" : "(没有输出内容)"),
      at: Date.now(),
      askedWith: user,
      // 显示那个数只有一份实现（`shared/cost.ts`）；真实用量另存 `usage`（C5）
      cost: fabricatedCost(raw.text),
      ...(raw.usage ? { usage: raw.usage } : {}),
      // 这一步用过的工具（§141）：重跑时也照记，才能一眼看出"这条回复动过什么"
      ...(raw.tools.length ? { tools: raw.tools } : {}),
    };
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === task.id
          ? {
              ...t,
              steps: t.steps.map((x) => (x.id === stepId ? fresh : x)),
              // 这条回复产出的旧产物换成新的（旧的留着会让"这句话产出了什么"对不上）
              artifacts: [...t.artifacts.filter((a) => a.stepId !== stepId), ...artifacts],
              stage: "done" as const,
              activity: "",
            }
          : t,
      ),
    }));
    await persistArtifacts(port, task.id, artifacts);
  },

  rate: (stepId, rating) =>
    set((s) => ({
      tasks: s.tasks.map((t) => ({
        ...t,
        steps: t.steps.map((x) => (x.id === stepId ? { ...x, rating: x.rating === rating ? undefined : rating } : x)),
      })),
    })),

  /*
   * P0-04：一键验证。
   *
   * 上限两次（与自动档同一条口径）：到上限仍失败就停在"验证未通过"，
   * 不让模型无限打补丁。执行走 `runToolOnce` 的 `run_command` 通道，
   * 与模型自己跑命令是同一套权限与同一条执行体。
   */
  runVerification: async (taskId) => {
    const task = get().tasks.find((t) => t.id === taskId);
    if (!task || task.stage !== "verify_ready" || !task.verifyPlan) return;
    if (isSessionRunning(taskId)) return;
    const plan = task.verifyPlan;
    if (plan.rounds >= 2) {
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === taskId
            ? { ...t, stage: "done", finishedAt: Date.now(), activity: "验证未通过", verifyPlan: undefined }
            : t,
        ),
      }));
      return;
    }
    const result = await runToolOnce({
      name: "run_command",
      input: { command: plan.command, ...(plan.cwd ? { workdir: plan.cwd } : {}) },
      toolPolicy: readConfirmMode(),
    });
    const out = result.output as { exitCode?: unknown; output?: unknown; timedOut?: unknown } | undefined;
    const exitCode = typeof out?.exitCode === "number" ? out.exitCode : result.ok ? 0 : 1;
    const rounds = plan.rounds + 1;
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId && t.verifyPlan
          ? { ...t, verifyPlan: { ...t.verifyPlan, rounds, lastExitCode: exitCode } }
          : t,
      ),
    }));
    const message = verificationMessage({
      command: plan.command,
      exitCode,
      stdout: typeof out?.output === "string" ? out.output : "",
      stderr: result.ok ? "" : (result.error ?? ""),
      timedOut: out?.timedOut === true,
    });
    /* 失败到上限：模型可以继续改，但不再出第三张验证卡（上限在 runVerification 开头判） */
    await continueWithUserMessage(port, taskId, message, { skipVerify: false });
  },

  skipVerification: (taskId) => {
    const task = get().tasks.find((t) => t.id === taskId);
    if (!task || task.stage !== "verify_ready") return;
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? { ...t, stage: "done", finishedAt: Date.now(), activity: "已完成（用户跳过验证）", verifyPlan: undefined }
          : t,
      ),
    }));
    appendStepNote(port, taskId, "用户跳过验证（本轮没有跑测试）");
  },

  /*
   * 放行 / 拒绝（§144）。
   *
   * ⚠️ 结果**落回那一条 trace 上**（改它的文案与状态），不是"在旁边飘一个提示" ——
   * 飘提示的话刷新就没了，用户回头再看这条回复会以为"当时就执行了"。
   */
  resolveTool: async (taskId, stepId, toolCallId, approve, opts) => {
    /*
     * ⚠️⚠️ **同一次调用只许处置一遍**（2026-10-16 审计 P48 的根因那一半）。
     *
     * `runToolOnce` 是**真在主进程干活**的（写文件、跑命令、装插件）。
     * 而界面上那两颗键原来是裸的 `onClick`：连点两下、或者两个入口同时点，
     * 就会把同一个副作用执行两遍。界面侧现在也会禁用（`ToolTraceList`），
     * 但界面禁用拦不住"绕过界面"的路 —— 收口放在这里才管用：
     *   · `pending` 已经是 false → 这一条早就处置过了，直接返回；
     *   · 同一把键（任务 + 调用 id）正在执行 → 不并发进第二遍。
     */
    const guardKey = `${taskId}/${toolCallId}`;
    if (resolvingTools.has(guardKey)) return;
    const snapshot = get();
    const before = snapshot.tasks
      .find((t) => t.id === taskId)
      ?.steps.find((x) => x.id === stepId)
      ?.tools?.find((tt) => tt.toolCallId === toolCallId);
    if (!before) return;
    // 已经处置过（pending 落成 false）就不再来一遍 —— 否则"副作用执行两遍"
    if (!before.pending) return;
    resolvingTools.add(guardKey);
    try {
      /** 只改那一条 trace（按 toolCallId 定位，不能按工具名 —— 一次回复里可能有多条）。 */
      const patchTrace = (next: Partial<ToolTrace>) =>
        set((s) => ({
          // ⚠️ 按**任务**限定（§151）：步骤 id 是按序号生成的，跨任务会撞
          tasks: s.tasks.map((t) =>
            t.id !== taskId
              ? t
              : {
                  ...t,
                  steps: t.steps.map((x) =>
                    x.id !== stepId
                      ? x
                      : {
                          ...x,
                          tools: (x.tools ?? []).map((tt) => (tt.toolCallId === toolCallId ? { ...tt, ...next } : tt)),
                        },
                  ),
                },
          ),
        }));

      if (!approve) {
        /*
         * 拒绝也**上报**（C2/INV-3）：主进程把决定记进会话日志。
         *
         * 原来这里纯在本地改一行 —— 重启后那条留痕又变回「等你确认」，
         * 而"谁拒的、拒了什么"查不到。现在与批准对称，文案也以主进程返回的为准。
         */
        const rejected = await runToolOnce({
          name: before.name,
          input: before.input,
          toolPolicy: readConfirmMode(),
          reject: true,
          toolCallId,
          ...(taskId ? { sessionId: taskSessionId(taskId) } : {}),
        });
        patchTrace({ pending: false, ok: true, rejected: true, line: rejected.line || rejectedLine(before.name) });
        /* P0-05：让模型知道"用户拒绝了"，并继续（不是停在"已拒绝"） */
        await maybeResumeAfterApproval(port, taskId, stepId);
        return;
      }

      const result = await runToolOnce({
        name: before.name,
        input: before.input,
        /*
         * ⚠️ 必须带上当前档位（§150）：`spawn_agent` 会按它给**子智能体**建工具集。
         * 不带的话，子智能体就会在一次"用户已放行"的名义下拿到全部放行权 ——
         * 那正是"审批穿透"要防的事。
         */
        toolPolicy: readConfirmMode(),
        // 决策要进日志（INV-3）：哪一次调用、哪段会话
        toolCallId,
        ...(taskId ? { sessionId: taskSessionId(taskId) } : {}),
      });
      patchTrace({
        pending: false,
        ok: result.ok,
        line: result.line,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      /*
       * 「总是允许」（U03）：**执行成功之后**才记规则。
       *
       * 顺序是刻意的：这条规则承诺的是"这类以后都不问"，
       * 如果这次执行本身失败了（路径不在白名单、命令报错），
       * 记下一条 allow 会让下一轮更难解释 —— 先做成，再记住。
       */
      if (opts?.remember && result.ok) {
        /* 设置那一侧的事交给 `taskRuntime`（store 不许自己读写 appSettings，见那条守卫） */
        await rememberAlwaysAllow(before.name, before.input);
      }
      /* P0-05：批准/失败都把结果送回模型，让它继续原任务 */
      await maybeResumeAfterApproval(port, taskId, stepId);
    } finally {
      resolvingTools.delete(guardKey);
    }
  },

  resolveAllTools: async (taskId, stepId, approve) => {
    const step = get()
      .tasks.find((t) => t.id === taskId)
      ?.steps.find((x) => x.id === stepId);
    const pending = (step?.tools ?? []).filter((t) => t.pending).map((t) => t.toolCallId);
    for (const toolCallId of pending) {
      await get().resolveTool(taskId, stepId, toolCallId, approve);
    }
    return pending.length;
  },

  transcript: () => {
    const state = get();
    const task = state.tasks.find((t) => t.id === state.activeTaskId);
    if (!task) return "";
    const lines = [`# ${task.title}`, "", `> ${task.brief}`, ""];
    for (const step of task.steps) {
      lines.push(step.role === "user" ? `**我：** ${step.text}` : `**Ding Harness：** ${step.text}`, "");
    }
    for (const artifact of task.artifacts) {
      lines.push(`- 产物：${artifact.title}（${artifact.filePath ?? "未落盘"}）`);
    }
    return lines.join("\n");
  },

  /**
   * 中止正在跑的轮次（P46：按会话/轮次，见 `abortRunning`）。
   *
   * 动作体整段搬去 `taskRuntime.ts`（C6-4 Step 3）：句柄只由 `runStream` 写，
   * "怎么中止这条流"要和"谁持有它"待在一起。
   */
  abort: (taskId) => abortRunning(port, taskId),

  /**
   * 在**已有的对话里**继续说一句（§147）。
   *
   * 为什么要有这个 action：任务视图里那个输入框原来提交的是 `createTask` ——
   * 于是在一段对话里接着说话会**新建一个任务**。也就是说这个应用**根本没有多轮对话**，
   * 而本体不是这样（它的「主对话」是多轮的）。
   *
   * 这条路径与 `createTask` 的区别只有两点：
   * ① 把**之前那几轮**作为 `messages` 历史一起发（`buildHistory`）；
   * ② 提示词换成"接着上文回应"（不把任务复述一遍，避免模型以为用户又提了一次）。
   */
  compactActive: async () => {
    const id = get().activeTaskId;
    if (!id) return { ok: false, error: "没有打开的对话" };
    if (isSessionRunning(id)) return { ok: false, error: "这一轮还在跑：等它说完再压缩" };
    return await compactNow(port, id);
  },

  sendInTask: async (taskId, message, options) => {
    const text = String(message ?? "").trim();
    if (!text) return;
    /*
     * ⚠️ **这一段对话已经在跑就不许再起一轮**（2026-10-16 审计 P46 的触发那一半）。
     *
     * 原来这里一行守卫都没有：`Composer` 的 Enter 分支只看 `shiftKey`、不看 `running`，
     * 而 `HomeView` 那颗按钮也不 disable —— 于是"同一段对话并发两轮"是**真走得到**的。
     * 两轮并发会一起改同一份 `steps`（步骤 id 按序号生成 → 必然撞）、一起往会话日志里写，
     * 而且第二轮的历史里**没有第一轮的回答**。
     *
     * 界面上已有明确出路：跑着的时候那颗键是「停止」（`Composer` 的 `running` 分支），
     * 所以这里拒绝不是在挡用户的正常操作，而是把"绕过界面"的那条路堵上。
     * （光靠这里也不够 —— 界面侧 `submit()` 同样会先说一句，见 `Composer.tsx`。）
     */
    if (isSessionRunning(taskId)) return;

    const state = get();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    const now = Date.now();
    /* G2：先落盘（拿到会话目录内的路径），再把引用挂到这一步上。 */
    const attachments = await persistAttachmentDrafts(taskId, options?.attachmentDrafts);
    const withNew: WorkTask = {
      ...task,
      /* 这一轮带的资料（没给就沿用任务上原来那份）—— 与"先问再干"那条路的口径一致。 */
      ...(options?.material ?? task.material ? { material: options?.material ?? task.material } : {}),
      steps: [
        ...task.steps,
        {
          id: makeStepId(task.steps.length + 1),
          role: "user",
          text,
          at: now,
          ...(attachments.length ? { attachments } : {}),
        },
      ],
      stage: "running",
      finishedAt: null,
      activity: "正在思考",
    };
    set((s) => ({
      /* 接着说一句也是"访问"这一段对话（P266 的另一处落点，与 `openTask` 同一口径） */
      tasks: upsertTask(s.tasks, withNew).map((t) => (t.id === taskId ? { ...t, openedAt: Date.now() } : t)),
      view: "task",
      activeTaskId: taskId,
    }));

    /*
     * ⚠️ 历史取的是**加新消息之前**的那份 steps —— 新那句话要作为
     * 这一次请求的 `user` 单独发（否则模型会看到同一个问题出现两次）。
     */
    await answerTurn(port, taskId, task.steps, text, undefined, withNew.material, options?.parts);
  },

  /** G1：面板里的编辑只改草稿，不动磁盘（批准那一刻才写）。 */
  setPlanText: (taskId, text) => {
    const state = get();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.planState !== "awaiting_approval" && task.planState !== "planning") return;
    const next = truncatePlan(text).text;
    set((s) => ({ tasks: upsertTask(s.tasks, { ...task, planText: next }) }));
  },

  /**
   * G1：放弃计划。
   *
   * 状态机拒绝非法迁移（执行中不能"放弃"回 idle —— 那会让界面以为没执行过）；
   * 清理草稿与路径，下一次计划重新开始。
   */
  abandonPlan: (taskId) => {
    const state = get();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const from = task.planState ?? "idle";
    if (!isPlanTransitionAllowed(from, "idle")) return;
    savePlanMode(false);
    set((s) => ({
      tasks: upsertTask(s.tasks, {
        ...task,
        planState: "idle",
        planText: undefined,
        planPath: undefined,
        planWriteError: undefined,
      }),
    }));
  },

  /**
   * G1：批准计划 → 写盘 → 进入执行态 → 自动发一句"开始执行"。
   *
   * 三条守卫都在**动作体**里，而不只在按钮的 disabled 上 ——
   * 按钮能绕过（键盘、测试、别的入口），状态机不能。
   */
  approvePlan: async (taskId) => {
    const state = get();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: "没有打开的对话" };
    /* 状态机、非空、五段齐全：判据只有一份（`planApprovalError`）。 */
    const blocked = planApprovalError(task.planState, task.planText);
    if (blocked) return { ok: false, error: blocked };
    const text = String(task.planText ?? "").trim();

    const bridge = (globalThis as unknown as { shell?: ShellBridge }).shell;
    let path = "";
    let writeError = "";
    try {
      const got = await bridge?.project?.writePlan?.({ sessionId: taskId, text });
      if (got?.ok) path = got.path;
      else writeError = got?.error ?? "写盘通道不可用";
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error);
    }

    /* 批准后全局计划开关必须关掉：执行轮要拿回写工具（工具面由内核按 plan 标志决定）。 */
    savePlanMode(false);
    set((s) => ({
      tasks: upsertTask(s.tasks, {
        ...current(s.tasks, taskId),
        planState: "executing",
        planText: text,
        ...(path ? { planPath: path } : {}),
        ...(writeError ? { planWriteError: writeError } : { planWriteError: undefined }),
      }),
    }));

    await get().sendInTask(taskId, "计划已批准，请按计划开始执行。");
    return { ok: true, ...(path ? { path } : {}), ...(writeError ? { error: writeError } : {}) };
  },

  /**
   * 回到某一步（§151）：丢掉那之后的轮次，并从那里重新回答。
   *
   * ⚠️ **不撤销已发生的动作**：记忆、画布节点、定时任务、产物都还在 ——
   * 回退改的是**这段对话**，不是世界。界面上那个动作旁边写着这句。
   */
  rewindTask: async (taskId, stepId) => {
    const state = get();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    /*
     * 按钮长在助手那一条上，但用户的意思是"这条回答不想要，重来" ——
     * 所以实际回到的是它**前面那句用户话**（保留并重答它）。
     * 见 `resolveRewindTarget`：回到助手那一步是"止步于此"，两者语义不同。
     */
    const target = resolveRewindTarget(task.steps, stepId);
    if (!target) return false;
    const plan = planRewind(task.steps, target);
    if (!plan) return false;

    // 先落截断（用户立刻看到"后面那些没了"），再决定要不要重答
    set((s) => ({
      tasks: upsertTask(s.tasks, {
        ...task,
        steps: plan.kept,
        stage: plan.reask ? "running" : "done",
        finishedAt: plan.reask ? null : Date.now(),
        activity: plan.reask ? "正在重新回答" : "",
      }),
    }));

    /* 停在助手话上就没有要重答的：用户接着往下说即可 —— 这一步**已经算成功**（截断做了） */
    if (!plan.reask) return true;
    /*
     * 重答那一步带一句说明 —— 用户要能看出"这条是回退之后重新答的"，
     * 否则回退前后看起来一模一样（自己都不确定刚才那下点没点上）。
     */
    await answerTurn(port, taskId, plan.kept.slice(0, -1), plan.reask, "已回到这一步重新回答", task.material);
    return true;
  },

  /**
   * 从某一步**分叉**成一段新对话（§151）。
   *
   * 分叉不等于复制：新对话拿到的是"到那一步为止"的内容，
   * **步骤 id 全部换新**，两条分支往后走时不会互相改到对方那一步。
   */
  branchTask: (taskId, stepId) => {
    const state = get();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const newId = nextId("t");
    /*
     * 步骤 id 带上新任务号，保证**跨任务不撞**（§151 顺手修的那个 bug 的同一处考虑）。
     * 不走 `makeStepId` —— 那个按序号生成（`s1`/`s2`），正是会撞的来源。
     */
    const branch = branchFrom(task, stepId, newId, (n) => `${newId}-s${n}`, Date.now());
    if (!branch) return;
    set((s) => ({ tasks: upsertTask(s.tasks, branch), activeTaskId: newId, view: "task" }));
  },

  editAndResend: async (taskId, stepId, newText) => {
    const text = String(newText ?? "").trim();
    if (!text) return false;
    const state = get();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    const newId = nextId("t");
    const branch = editedBranchFrom(task, stepId, text, newId, Date.now());
    if (!branch) return false;
    set((s) => ({ tasks: upsertTask(s.tasks, branch), activeTaskId: newId, view: "task" }));
    await answerTurn(port, newId, branch.steps.slice(0, -1), text, undefined, branch.material);
    return true;
  },

  createTask: async (message, options) => {
    const text = String(message ?? "").trim();
    if (!text) return undefined;

    const background = options?.background ?? false;
    const material = options?.material;
    const now = Date.now();
    /*
     * A3：首页选的是「编码」还是「办公」，**创建时写进任务并随它落盘**。
     * 之后提示词按任务上的 mode 选，不读"现在的首页开关"——
     * 切一下首页不该让一段已有对话换身份。
     */
    const mode: HomeMode = get().homeMode;
    /* G1：计划模式对编码/办公都生效；任务从 `planning` 起步。 */
    const plan = readPlanMode();
    const id = nextId("t");
    /* G2：新任务的 id 先生成，附件才能落到**这段会话自己的目录**里。 */
    const attachments = await persistAttachmentDrafts(id, options?.attachmentDrafts);
    const task: WorkTask = {
      id,
      mode,
      ...(plan ? { planState: "planning" as const } : {}),
      /*
       * 先用本地启发式给一个**即时**标题。
       *
       * 为什么不全靠模型：起标题要一次往返，等它回来列表里会先空一两秒。
       * 先用启发式把名字挂上、再由模型替换（`refineTitle`），
       * 既没有空窗，最终又是模型起的名字 —— 与上位口径一致
       * （上位 `moa_comms_taskTitleLimit` =「任务标题，不超过16个字。」，
       *  说明标题本来就是模型经工具参数产出的，不是本地截断）。
       */
      title: autoTaskTitle(text),
      brief: text,
      createdAt: now,
      stage: "running",
      startedAt: now,
      finishedAt: null,
      steps: [
        {
          id: makeStepId(1),
          role: "user",
          text,
          at: now,
          ...(attachments.length ? { attachments } : {}),
        },
      ],
      questions: [],
      questionIndex: 0,
      activity: "正在思考",
      artifacts: [],
      /* 资料随任务走（跨"先问再干"那次往返）—— 见 `WorkTask.material` 的说明。 */
      ...(material ? { material } : {}),
    };
    /*
     * `background` 的任务**不抢焦点**。
     *
     * 定时任务在后台到点触发时，如果照样切视图，用户正在干的事会被强行弹走 ——
     * 这是实测踩出来的：验收里点「立刻执行」之后，页面直接跳到了任务页，
     * 调度列表整个消失。前台发起（用户自己打字）当然要跳过去。
     */
    set((s) => ({
      view: background ? s.view : "task",
      activeTaskId: background ? s.activeTaskId : task.id,
      tasks: upsertTask(s.tasks, task),
    }));

    // 起标题与回答问题并行：标题回来了就替换，失败就留着启发式那份
    void refineTitle(port, task.id, text);

    const { system, user } = mode === "coding"
      ? buildCodingAskPrompt(text, [], material)
      : buildAskPrompt(text, [], material);
    const reply = await runStream(
      port,
      user,
      system,
      (patch) => {
        set((s) => ({ tasks: upsertTask(s.tasks, { ...current(s.tasks, task.id), ...patch }) }));
      },
      [],
      task.id,
      options?.parts,
      plan,
      mode === "coding",
    );

    const finishNote = finishNoteOf(reply.tools, reply.wroteFiles);
    nextStep(port, task.id, reply.text, false, user, reply.tools, finishNote || undefined, reply.usage);
    /* P0-04：决策与执行都收在 taskRuntime 里（自动跑 / 出卡片 / 写"未验证"） */
    if (reply.wroteFiles) await verifyAfterTurn(port, task.id, mode);
    /*
     * G1：计划阶段收尾。若这一轮又问了澄清问题（`stage === "awaiting"`），
     * 计划还没成形 —— 保持在 planning，等用户答完的 do 阶段再收。
     */
    if (plan) {
      const after = current(get().tasks, task.id);
      if (after && after.stage !== "awaiting") {
        set((s) => ({
          tasks: upsertTask(s.tasks, {
            ...current(s.tasks, task.id),
            planState: "awaiting_approval",
            planText: truncatePlan(reply.text).text,
          }),
        }));
      }
    }
    return task.id;
  },

  answer: async (option, custom) => {
    const state = get();
    const task = state.tasks.find((t) => t.id === state.activeTaskId);
    if (!task) return;
    const question = task.questions[task.questionIndex];
    if (!question) return;

    const answerText = describeAnswer(question, option, custom);
    const advanced = answerQuestion(task, answerText, makeStepId(task.steps.length + 1), Date.now());
    set({ tasks: upsertTask(state.tasks, advanced) });

    // 还有下一题就停下等用户；答完了才继续干活
    if (advanced.stage !== "running") return;

    const background = advanced.steps
      .filter((s) => s.role === "user" && s.text.includes(" → "))
      .map((s) => s.text);
    const { system, user } = taskMode(advanced) === "coding"
      ? buildCodingDoPrompt(advanced.brief, background, advanced.material)
      : buildDoPrompt(advanced.brief, background, advanced.material);
    /* G1：澄清答完后，do 阶段仍然属于计划阶段 —— 不能因为一次往返丢掉只读工具面。 */
    const planRequested = Boolean(readPlanMode() && advanced.planState !== "executing");
    const reply = await runStream(
      port,
      user,
      system,
      (patch) => {
        set((s) => ({ tasks: upsertTask(s.tasks, { ...current(s.tasks, advanced.id), ...patch }) }));
      },
      [],
      advanced.id,
      undefined,
      planRequested,
    );

    // 第二段如果又吐了提问块，也照收（模型有时会追问，原版也允许）
    nextStep(port, advanced.id, reply.text, true, user, reply.tools, undefined, reply.usage);
    if (planRequested) {
      const after = current(get().tasks, advanced.id);
      if (after && after.stage !== "awaiting") {
        set((s) => ({
          tasks: upsertTask(s.tasks, {
            ...current(s.tasks, advanced.id),
            planState: "awaiting_approval",
            planText: truncatePlan(reply.text).text,
          }),
        }));
      }
    }
  },
}));

/* ============================================================
 * 任务持久化（阶段 11.9）—— 实现搬去 `taskPersist.ts`（C6-4 Step 2）
 * ============================================================ */

/*
 * 下面两个是**薄转发**：实现整套在 `taskPersist.ts`，这里只把 `port`（本 store 的
 * 那一小块读写能力，见上面 `StorePort`）注入进去 —— 新模块因此不静态 import store。
 *
 * ⚠️ 签名逐字不变（`(): Promise<string[]>` / `(): () => void`）：
 * `Workbench.tsx:127/129` 是调用方，一行都不用改。
 */

/**
 * 从磁盘恢复任务历史。
 *
 * 顺序上必须在**载入本机库之前**跑：库要拿任务 id 去剔悬空的置顶/项目成员，
 * 任务没恢复完就去剔，会把好数据当悬空项清掉。
 *
 * @returns 恢复到的任务 id（供库载入时做收窄）
 */
export async function restoreTasks(): Promise<string[]> {
  return restoreTasksIn(port);
}

/**
 * 开始监听任务变化并持久化。
 * @returns 停止函数
 */
export function startTaskPersistence(): () => void {
  return startTaskPersistenceIn(port);
}

/** 造一个步骤 id（对外暴露给需要稳定 id 的地方）。 */
export { nextStepId } from "./task";

/** 打开一个产物（用系统默认程序）。 */
export async function openArtifact(filePath: string): Promise<string> {
  const bridge = (window as unknown as { shell?: ShellBridge }).shell;
  if (!bridge?.workbench) return "通道不可用";
  return bridge.workbench.openArtifact(filePath);
}

/** 在文件管理器里定位一个产物。 */
export async function revealArtifact(filePath: string): Promise<boolean> {
  const bridge = (window as unknown as { shell?: ShellBridge }).shell;
  if (!bridge?.workbench) return false;
  return bridge.workbench.revealArtifact(filePath);
}
