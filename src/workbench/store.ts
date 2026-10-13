import { create } from "zustand";
import type { ChatMessage, ShellBridge } from "@shared/ipc";
import { streamChat, runToolOnce, completeOnce } from "../ai/aiClient";
import { buildAskPrompt, buildDoPrompt, buildFollowUpPrompt, describeAnswer, parseAskReply } from "./agent";
import { artifactFileName, extractArtifacts, type Artifact } from "./artifact";
import { enabledPromptBlock } from "@shared/library";
import { fallbackNote } from "@shared/settings";
import {
  rejectedLine,
  toolLabel,
  type ToolTrace,
} from "@shared/agentTools";
import { applyEvent, emptyTurn, finishTurn, taskSessionId } from "@shared/sessionLog";
import { assembleSystem } from "@shared/turnAssembly";
import { fabricatedCost, type StepUsage } from "@shared/cost";
import { buildHistory } from "./history";
import { agentPromptBlock } from "./agentStore";
import { memoryPromptBlock } from "@shared/memory";
import { useMemoryStore } from "./memoryStore";
import { resolveChatRoute } from "@/ai/route";
import { branchFrom, planRewind, resolveRewindTarget } from "./checkpoint";
import {
  KEEP_TOKENS,
  compactedNote,
  compactPrompt,
  shouldCompact,
  signatureOf,
  planContext,
  withSummary,
} from "./compaction";
import { readConfirmMode } from "./confirmMode";
import { pickSuggestions, SUGGESTION_POOL } from "./copy";
import {
  acceptQuestions,
  answerQuestion,
  autoTaskTitle,
  cleanTitle,
  makeStepId,
  normalizeStep,
  normalizeQuestions,
  normalizeArtifacts,
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

/** 工作台里的一个"页面"。 */
export type WorkbenchView = "home" | "task" | "scheduled" | "plugins" | "cloud" | "phone" | "threads" | "doc" | "center" | "reader" | "agent" | "coding" | "image" | "video";

type WorkbenchState = {
  view: WorkbenchView;
  tasks: WorkTask[];
  activeTaskId: string | null;
  /** 正在跑的请求（用于中止）。 */
  runningRequestId: string | null;
  /** 首页推荐卡（原版会给，且内容会变）。 */
  suggestions: string[];
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
  /** 带着草稿跳到定时任务页。 */
  scheduleFromTask: (title: string, prompt: string) => void;
  /** 把一句话交到主输入区（§159「创作同款」）。 */
  setComposerDraft: (text: string) => void;
  /** 取走那句草稿（取一次就清）。 */
  takeComposerDraft: () => string | null;
  takeScheduleDraft: () => { title: string; prompt: string } | null;

  setView: (view: WorkbenchView) => void;
  toggleCanvas: () => void;
  /** 打开悬浮助手窗；给了 `seed` 就带着这个问题打开。 */
  openFloat: (seed?: string) => void;
  closeFloat: () => void;
  /** 新建一个任务并立刻开始跑（对应原版"发消息或创建任务"）。 */
  createTask: (message: string, options?: { background?: boolean }) => Promise<void>;
  /** 在已有对话里继续说一句（§147）—— 与 `createTask` 的区别是带上历史。 */
  sendInTask: (taskId: string, message: string) => Promise<void>;
  /**
   * 回到某一步并从那里重来（§151）。
   *
   * ⚠️ **不撤销已发生的动作**（记忆、画布、定时任务、产物都还在）——
   * 回退改的是这段对话，不是世界。
   */
  rewindTask: (taskId: string, stepId: string) => Promise<void>;
  /** 从某一步分叉成一段新对话（§151）。 */
  branchTask: (taskId: string, stepId: string) => void;
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
  resolveTool: (taskId: string, stepId: string, toolCallId: string, approve: boolean) => Promise<void>;
  /** 生成整段对话的 Markdown（分享/导出用）。 */
  transcript: () => string;
  /** 中止当前任务。 */
  abort: () => void;
};

/** 已进入"最近的"任务（用于左侧列表，最新的在前）。 */
function upsertTask(tasks: WorkTask[], patch: WorkTask): WorkTask[] {
  const index = tasks.findIndex((t) => t.id === patch.id);
  if (index === -1) return [patch, ...tasks];
  const next = [...tasks];
  next[index] = patch;
  return next;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

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
  floatOpen: false,
  floatSeed: "",
  openFloat: (seed) => set({ floatOpen: true, floatSeed: seed ?? "" }),
  closeFloat: () => set({ floatOpen: false, floatSeed: "" }),

  composerDraft: null,
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
  takeComposerDraft: () => {
    const draft = get().composerDraft;
    if (draft) set({ composerDraft: null });
    return draft;
  },
  // 实机的推荐卡**会变**；从池子里抽四条，每次进首页重新抽
  suggestions: pickSuggestions(SUGGESTION_POOL),

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
  refreshSuggestions: () => set({ suggestions: pickSuggestions(SUGGESTION_POOL) }),

  openTask: (id) => set({ view: "task", activeTaskId: id }),

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
    const { system } = buildDoPrompt(task.brief, background);
    const raw = await runStream(user, system, patch, [], task.id);
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
    await persistArtifacts(task.id, artifacts);
  },

  rate: (stepId, rating) =>
    set((s) => ({
      tasks: s.tasks.map((t) => ({
        ...t,
        steps: t.steps.map((x) => (x.id === stepId ? { ...x, rating: x.rating === rating ? undefined : rating } : x)),
      })),
    })),

  /*
   * 放行 / 拒绝（§144）。
   *
   * ⚠️ 结果**落回那一条 trace 上**（改它的文案与状态），不是"在旁边飘一个提示" ——
   * 飘提示的话刷新就没了，用户回头再看这条回复会以为"当时就执行了"。
   */
  resolveTool: async (taskId, stepId, toolCallId, approve) => {
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

    const step = get()
      .tasks.find((t) => t.id === taskId)
      ?.steps.find((x) => x.id === stepId);
    const trace = step?.tools?.find((tt) => tt.toolCallId === toolCallId);
    if (!trace || !step) return;

    if (!approve) {
      /*
       * 拒绝也**上报**（C2/INV-3）：主进程把决定记进会话日志。
       *
       * 原来这里纯在本地改一行 —— 重启后那条留痕又变回「等你确认」，
       * 而"谁拒的、拒了什么"查不到。现在与批准对称，文案也以主进程返回的为准。
       */
      const rejected = await runToolOnce({
        name: trace.name,
        input: trace.input,
        toolPolicy: readConfirmMode(),
        reject: true,
        toolCallId,
        ...(taskId ? { sessionId: taskSessionId(taskId) } : {}),
      });
      patchTrace({ pending: false, ok: true, line: rejected.line || rejectedLine(trace.name) });
      return;
    }

    const result = await runToolOnce({
      name: trace.name,
      input: trace.input,
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
  },

  transcript: () => {
    const state = get();
    const task = state.tasks.find((t) => t.id === state.activeTaskId);
    if (!task) return "";
    const lines = [`# ${task.title}`, "", `> ${task.brief}`, ""];
    for (const step of task.steps) {
      lines.push(step.role === "user" ? `**我：** ${step.text}` : `**豆包工作：** ${step.text}`, "");
    }
    for (const artifact of task.artifacts) {
      lines.push(`- 产物：${artifact.title}（${artifact.filePath ?? "未落盘"}）`);
    }
    return lines.join("\n");
  },

  abort: () => {
    const id = get().runningRequestId;
    if (id) void import("../ai/aiClient").then((m) => m.abortStream(id));
    set({ runningRequestId: null });
  },

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
  sendInTask: async (taskId, message) => {
    const text = String(message ?? "").trim();
    if (!text) return;

    const state = get();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    const now = Date.now();
    const withNew: WorkTask = {
      ...task,
      steps: [...task.steps, { id: makeStepId(task.steps.length + 1), role: "user", text, at: now }],
      stage: "running",
      finishedAt: null,
      activity: "正在思考",
    };
    set((s) => ({ tasks: upsertTask(s.tasks, withNew), view: "task", activeTaskId: taskId }));

    /*
     * ⚠️ 历史取的是**加新消息之前**的那份 steps —— 新那句话要作为
     * 这一次请求的 `user` 单独发（否则模型会看到同一个问题出现两次）。
     */
    await answerTurn(taskId, task.steps, text);
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
    if (!task) return;
    /*
     * 按钮长在助手那一条上，但用户的意思是"这条回答不想要，重来" ——
     * 所以实际回到的是它**前面那句用户话**（保留并重答它）。
     * 见 `resolveRewindTarget`：回到助手那一步是"止步于此"，两者语义不同。
     */
    const target = resolveRewindTarget(task.steps, stepId);
    if (!target) return;
    const plan = planRewind(task.steps, target);
    if (!plan) return;

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

    // 停在助手话上就没有要重答的：用户接着往下说即可
    if (!plan.reask) return;
    /*
     * 重答那一步带一句说明 —— 用户要能看出"这条是回退之后重新答的"，
     * 否则回退前后看起来一模一样（自己都不确定刚才那下点没点上）。
     */
    await answerTurn(taskId, plan.kept.slice(0, -1), plan.reask, "已回到这一步重新回答");
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

  createTask: async (message, options) => {
    const text = String(message ?? "").trim();
    if (!text) return;

    const background = options?.background ?? false;
    const now = Date.now();
    const task: WorkTask = {
      id: nextId("t"),
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
      steps: [{ id: makeStepId(1), role: "user", text, at: now }],
      questions: [],
      questionIndex: 0,
      activity: "正在思考",
      artifacts: [],
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
    void refineTitle(task.id, text);

    const { system, user } = buildAskPrompt(text);
    const reply = await runStream(
      user,
      system,
      (patch) => {
        set((s) => ({ tasks: upsertTask(s.tasks, { ...current(s.tasks, task.id), ...patch }) }));
      },
      [],
      task.id,
    );

    nextStep(task.id, reply.text, false, user, reply.tools, undefined, reply.usage);
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
    const { system, user } = buildDoPrompt(advanced.brief, background);
    const reply = await runStream(
      user,
      system,
      (patch) => {
        set((s) => ({ tasks: upsertTask(s.tasks, { ...current(s.tasks, advanced.id), ...patch }) }));
      },
      [],
      advanced.id,
    );

    // 第二段如果又吐了提问块，也照收（模型有时会追问，原版也允许）
    nextStep(advanced.id, reply.text, true, user, reply.tools, undefined, reply.usage);
  },
}));

/** 取当前任务（找不到时用传入的兜底，避免闭包里拿到旧对象）。 */
function current(tasks: WorkTask[], id: string): WorkTask {
  return tasks.find((t) => t.id === id) ?? tasks[0];
}

/**
 * 让模型给任务起标题（对标上位 `moa_comms_taskTitleLimit` =「任务标题，不超过16个字。」）。
 *
 * 起名失败**不报错也不打断**：本地启发式那份标题还在，用户看不到任何异常。
 * 但要把结果**清洗**一遍 —— 模型常常带引号、书名号、句号，
 * 或者干脆回一句「好的，标题是…」，直接塞进列表会很难看。
 *
 * @param taskId 任务 id
 * @param brief 用户原话
 */
async function refineTitle(taskId: string, brief: string): Promise<void> {
  const route = await resolveRoute();
  if (!route.provider) return;

  let acc = "";
  try {
    const handle = await streamChat(
      {
        provider: route.provider,
        model: route.model,
        messages: [{ role: "user", content: brief }],
        system: [
          "给这个任务起一个标题。",
          "要求：不超过 16 个字；只输出标题本身，不要引号、不要标点结尾、不要任何解释。",
        ].join("\n"),
      },
      (event) => {
        if (event.type === "text") acc += event.text;
      },
    );
    await handle.done;
  } catch {
    return; // 起名是锦上添花，失败就当没发生
  }

  const title = cleanTitle(acc);
  if (!title) return;
  useWorkbenchStore.setState((s) => ({
    tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, title } : t)),
  }));
}


/**
 * 解析本次要用的 provider / model。
 *
 * 优先读聊天那边保存的设置；**读不到就现场挑一个可用的** ——
 * 否则会把空字符串发给主进程，得到 `未知 provider:` 这种没头没脑的报错
 * （实测踩过：全新的用户数据目录里没有这条设置，任务直接秒失败）。
 *
 * 挑选顺序跟聊天侧栏一致：优先已验证可用的，其次只是有密钥的。
 */
/**
 * 解析路由 —— 实现搬去 `src/ai/route.ts` 了（§153 抽成共用件，
 * 免得 AI 文档那条路自己写一份、出现"对话能用、润色说没通道"的自相矛盾）。
 */
const resolveRoute = resolveChatRoute;


/** 生成一个步骤 id（不用渲染层的东西，主进程/测试里也能用）。 */
function nextStepId(): string {
  return makeStepId(Date.now());
}

/* ============================================================
 * 任务持久化（阶段 11.9）
 * ============================================================ */

/** 恢复时把盘上的数据收窄成合法任务（磁盘内容按不可信处理）。 */
/**
 * 恢复一个任务（§179 起导出，供单测直接钉住恢复口径）。
 *
 * @param raw 落盘的一条（不可信）
 * @returns 合法任务；连 id 都没有就给 null
 */
export function normalizeTask(raw: unknown): WorkTask | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || !t.id) return null;
  const steps = Array.isArray(t.steps)
    ? t.steps
        .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
        /*
         * 逐条交给 `normalizeStep`（§177 抽出来的纯函数）——
         * 这一段原来内联在这里，于是**没法单测**，而它恰恰最容易漏字段
         * （§176 漏了 `tools`、§177 漏了 `note`）。现在每个字段都有断言守着。
         */
        .map((s, i) => normalizeStep(s, i))
    : [];
  /*
   * 产物与澄清卡也要收窄（§179）：原来这两句是**裸断言**
   * （`as TaskQuestion[]` / `as Artifact[]`）。忽視澄清卡的 `options` 时
   * 界面上的 `question.options.map(...)` 会直接抛异常 —— **那一整段对话打不开**。
   */
  const questions = normalizeQuestions(t.questions);
  const artifacts = normalizeArtifacts(t.artifacts);

  const stage = t.stage;
  /*
   * ⚠️ 只有 `running` 算"中断"（§179）。
   *
   * `awaiting` **不是**进行中 —— 它等的是**用户回答**，不是某个请求。
   * 原来把两者一起标成 `failed`，后果很具体：
   * 界面上澄清卡只在 `stage === "awaiting"` 时渲染 →
   * **重启之后那张卡永远不出现，用户再也回答不了那个问题**，
   * 而那一次对话就卡在那里了（它不是坏了，是在等人）。
   *
   * 这与本项目"闸门/审批的意义就是用户看得见并决定"是同一条：
   * **在等人的状态不该被系统自己判死。**
   */
  const wasRunning = stage === "running";
  return {
    id: t.id,
    title: typeof t.title === "string" && t.title ? t.title : "未命名任务",
    brief: typeof t.brief === "string" ? t.brief : "",
    createdAt: typeof t.createdAt === "number" ? t.createdAt : 0,
    /*
     * 上次关窗口时还在跑/还在等回答的任务，恢复时标成 `failed` 并写清原因。
     * 原样留成 running 的话，界面会显示一个**永远转下去**的任务，
     * 而它其实早就没有请求在跑了 —— 那比标成失败更让人困惑。
     */
    stage: wasRunning ? "failed" : (stage as WorkTask["stage"]),
    startedAt: typeof t.startedAt === "number" ? t.startedAt : null,
    finishedAt: typeof t.finishedAt === "number" ? t.finishedAt : wasRunning ? Date.now() : null,
    steps,
    questions,
    questionIndex: typeof t.questionIndex === "number" ? t.questionIndex : 0,
    activity: wasRunning ? "上次关闭时被中断" : typeof t.activity === "string" ? t.activity : "",
    artifacts,
  };
}

/**
 * 从磁盘恢复任务历史。
 *
 * 顺序上必须在**载入本机库之前**跑：库要拿任务 id 去剔悬空的置顶/项目成员，
 * 任务没恢复完就去剔，会把好数据当悬空项清掉。
 *
 * @returns 恢复到的任务 id（供库载入时做收窄）
 */
export async function restoreTasks(): Promise<string[]> {
  const bridge = (globalThis as unknown as { shell?: ShellBridge }).shell;
  if (!bridge?.tasks) return [];
  const raw = await bridge.tasks.load();
  const tasks = raw.map(normalizeTask).filter((t): t is WorkTask => t !== null);
  if (tasks.length === 0) return [];
  useWorkbenchStore.setState({
    tasks,
    activeTaskId: tasks[0]?.id ?? null,
  });
  return tasks.map((t) => t.id);
}

/** 写盘队列：串行化，避免并发写互相覆盖。 */
let saveQueue: Promise<unknown> = Promise.resolve();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 落盘当前任务列表（防抖）。
 *
 * 防抖是必要的：流式回复时 steps 每个片段都在变，不防抖会**每几十毫秒写一次盘**。
 */
function schedulePersist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!saveTimer) return;
    saveTimer = null;
    const bridge = (globalThis as unknown as { shell?: ShellBridge }).shell;
    if (!bridge?.tasks) return;
    const tasks = useWorkbenchStore.getState().tasks;
    saveQueue = saveQueue.then(() => bridge.tasks.save(tasks)).catch(() => undefined);
  }, 600);
}

/**
 * 开始监听任务变化并持久化。
 * @returns 停止函数
 */
export function startTaskPersistence(): () => void {
  const unsubscribe = useWorkbenchStore.subscribe((state, prev) => {
    if (state.tasks !== prev.tasks) schedulePersist();
  });
  return () => {
    unsubscribe();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  };
}

/** 造一个步骤 id（对外暴露给需要稳定 id 的地方）。 */
export { nextStepId };

/**
 * 取"本次启用能力"的提示词片段（阶段 11.7）。
 *
 * 上位把启用项走 `extraExt.input_skill = JSON.stringify({skill_id, skill_type})`
 * 交给服务端，由**服务端**注入这些能力的 schema。单机版没有那一层，
 * 所以退化成"在系统提示词里说清这次可以用什么" —— 这是**有意降级**：
 * 模型至少知道该用什么，而不是完全不知道。
 *
 * @returns 系统提示词片段；没有启用项时返回空串
 */
async function enabledBlock(): Promise<string> {
  try {
    const { useLibraryStore, findItemIn } = await import("./libraryStore");
    const lib = useLibraryStore.getState().lib;
    // 用 findItemIn 而不是 findItem：自定义能力不在内置目录里，
    // 只查目录会让它们进了 enabled 也拿不到名字 —— 等于装了没用。
    return enabledPromptBlock(lib, (id) => findItemIn(lib, id));
  } catch {
    return "";
  }
}

/**
 * 保留额度（§149）。
 *
 * 正常就是 `KEEP_TOKENS = 20000`。**本地存储里那个键是给验收用的开关** ——
 * 不然要验证"压了之后还能答对"，得先造一段两万 token 的真实对话（十几次模型调用）。
 * 界面上没有入口，生产不会有人设它。
 *
 * 读不到 / 读到乱值就回落默认值：这个值只影响"什么时候压"，不该让请求失败。
 */
function compactKeepTokens(): number {
  try {
    const raw = Number(localStorage.getItem("dsh-canvas.compact-keep-tokens"));
    return Number.isFinite(raw) && raw > 0 ? raw : KEEP_TOKENS;
  } catch {
    return KEEP_TOKENS;
  }
}

/**
 * 摘要缓存（§149）：同一个任务、**同一批要压的消息**就复用上次的摘要。
 *
 * 不缓存的话每一次追问都会多花一次压缩调用 —— 用户问三句就白花三次。
 */
const summaryCache = new Map<string, { sig: string; summary: string }>();

/**
 * 把更早那批对话压成要点。
 *
 * @param taskId 哪个任务（缓存的键）
 * @param older 要压的消息（旧 → 新）
 * @returns 摘要文本；**失败返回空串**（调用方据此降级成"发完整历史"）
 */
async function summaryFor(taskId: string, older: ChatMessage[]): Promise<string> {
  const sig = signatureOf(older);
  const cached = summaryCache.get(taskId);
  if (cached && cached.sig === sig) return cached.summary;

  try {
    const route = await resolveRoute();
    const { system, user } = compactPrompt(older);
    const { text, error } = await completeOnce({
      provider: route.provider,
      model: route.model,
      messages: [{ role: "user", content: user }],
      system,
    });
    // 通道那头报错也算失败 → 走下面的降级（不把错误当摘要写进去）
    if (error) return "";
    const summary = text.trim();
    if (summary) summaryCache.set(taskId, { sig, summary });
    return summary;
  } catch {
    /*
     * 压缩失败**不是**这一次对话的失败：降级成"发截断后的完整历史"（§147 的行为）。
     * 沉默地吞掉是对的 —— 用户不需要知道"后台那次摘要调用失败了"，
     * 他需要的是这轮对话照常进行。
     */
    return "";
  }
}

/**
 * 用"接着聊"那条路回答一句（§147 / §149 / §151 共用）。
 *
 * 抽出来是因为现在有**两个**入口走这条路：用户自己接着说一句（`sendInTask`），
 * 以及**回退之后重新回答**（`rewindTask`）。两处各写一份的话，
 * 压缩与历史那套逻辑早晚会在其中一处悄悄过期 —— 而那种错极难从现象上看出来。
 *
 * @param taskId 哪段对话
 * @param history 这次**之前**的步骤（不含这次要发的那句）
 * @param text 这次要发的那句
 */
async function answerTurn(taskId: string, history: TaskStep[], text: string, extraNote?: string): Promise<void> {
  const { messages, truncated } = buildHistory(history);

  /*
   * 上下文压缩（§149）。
   *
   * 顺序很要紧：**先按消息边界切、再决定压不压**，压成功才只发 recent + 摘要。
   * 压失败就退回"发截断后的完整历史" —— 不能因为压缩失败就把更早的内容
   * 悄悄丢掉（那等于压缩把上下文弄丢了）。
   */
  const keepTokens = compactKeepTokens();
  let effective = messages;
  let summary = "";
  let olderCount = 0;
  if (shouldCompact(messages, keepTokens)) {
    const { older, recent } = planContext(messages, keepTokens);
    if (older.length > 0) {
      summary = await summaryFor(taskId, older);
      if (summary) {
        effective = recent;
        olderCount = older.length;
      }
    }
  }

  const { system: baseSystem, user } = buildFollowUpPrompt(text, truncated);
  const system = withSummary(baseSystem, summary);
  const reply = await runStream(
    user,
    system,
    (patch) => {
      useWorkbenchStore.setState((s) => ({ tasks: upsertTask(s.tasks, { ...current(s.tasks, taskId), ...patch }) }));
    },
    effective,
    taskId,
  );

  /*
   * 这一步要额外告诉用户的话。两种来源合并：
   * ① `extraNote` —— 例如"已回到这一步重新回答"（§151）；
   * ② 压缩提示（§149）。
   * 合成一行而不是两条：界面上那一行本来就只放一句。
   */
  const notes = [extraNote, reply.note, olderCount ? compactedNote(olderCount) : ""].filter(Boolean);
  nextStep(
    taskId,
    reply.text,
    false,
    user,
    reply.tools,
    notes.length ? notes.join("；") : undefined,
    reply.usage,
  );
}

/**
 * 跑一次流式请求，把增量写进当前任务的活动状态。
 *
 * @param user 用户内容
 * @param system 系统提示词（已拼好摘要）
 * @param onPatch 把增量状态合并进任务
 * @returns 模型的完整输出
 */
async function runStream(
  user: string,
  system: string,
  onPatch: (patch: Partial<WorkTask>) => void,
  /**
   * 之前几轮的历史（§147）。
   *
   * 缺省为空 = 只发这一句（`createTask` / 起标题 / 重生成那些路径就是如此）。
   * 传了历史就是多轮：**旧消息在前、这次的新消息在后** —— 顺序反了模型会把因果读反。
   */
  history: ChatMessage[] = [],
  /**
   * 这一轮属于哪个会话（C2）：主进程据此把请求与事件写进会话日志。
   *
   * 工作台用**任务 id**（一段任务就是一段会话）；不给就不记日志 ——
   * 起标题这类附带请求走的是别的函数，压根不到这里。
   */
  sessionId = "",
): Promise<{ text: string; tools: ToolTrace[]; usage?: StepUsage; note?: string }> {
  const messages: ChatMessage[] = [...history, { role: "user", content: user }];
  /*
   * ⚠️ 「新对话默认模型」（§183）只在这种时候生效：
   * **这条对话还没有任何历史**（`history` 为空 = 这就是第一句）。
   *
   * 默认模型不该劫持一段正在进行的对话 —— 用户在那段里手动换过模型，
   * 再发一句又被拽回默认，那是很讨厌的事。
   */
  const route = await resolveRoute({ fresh: history.length === 0 });
  /*
   * 钉的默认模型失效了就说一句（§184）。
   *
   * ⚠️ note 挂在**步骤**上（§149 那个机制），所以这里先记在局部变量里、
   * 跟着返回值交给 `answerTurn` —— 不能直接 `onPatch({ note })`（那是任务字段）。
   */
  const fellBackNote = route.fellBack && route.pinned ? fallbackNote(route.pinned) : "";
  // 启用能力拼在系统提示词末尾：任务本身的要求在前，能力说明在后
  /*
   * 选中的 AI 智能体（§156）：它的「设定描述 + 标签」要拼进系统提示词 ——
   * 模型看不到我们那些数组，只有写进去它才会以那个身份说话。
   * 放在能力说明**之前**：人设是"你是谁"，能力是"你能用什么"。
   */
  const persona = agentPromptBlock();
  const extra = await enabledBlock();
  /*
   * 长期记忆（§164）：工具描述里一直写着"之后每次对话都会自动带上"，
   * 而 `memoryPromptBlock` **从来没被调用过** —— 描述与现状不一致。
   * 这里补上：放在人设之后、能力说明之前。
   */
  const remembered = memoryPromptBlock(useMemoryStore.getState().lib);
  /*
   * 装配收成一份纯函数（C2-4）：聊天侧用的是**同一个** `assembleSystem`。
   * 不这么做的时候两边是各写一遍的 —— 于是聊天侧压根没有记忆与人设（实测）。
   */
  const fullSystem = assembleSystem({ base: system, persona, memory: remembered, abilities: extra });
  /**
   * 这一轮的**投影**（C2）：正文、工具留痕、用量只有一份算法。
   *
   * ⚠️ 这里原来是**第二份**手写状态机（`acc` + `tools` + `inputs` 那个 Map），
   * 与聊天侧那份各写一遍，于是两边慢慢答得不一样 —— 这一侧最刺眼的一条是：
   * `onEvent` **没有 `done` 分支**，主进程发来的真实 `usage` 落到这里就没了
   * （界面上的「消耗」因此一直是按字数估的）。
   *
   * 现在与聊天侧共用 `applyEvent`（`shared/sessionLog.ts`）。
   * ⚠️ 界面显示的那个数**本轮不动**（仍按原口径估）—— 换成真实用量是 C5 的事，
   * 这里只保证"真实用量不再被丢掉"（`view.usage`）。
   */
  let turn = emptyTurn();
  /**
   * 工作台**展开**子智能体上交的调用（`expandBlocked`，§176）：
   * 它们挂成这一步上的待批准项，用户能就地放行 —— 这是原有行为。
   */
  const project = () => finishTurn(turn, { expandBlocked: true });

  onPatch({ activity: "正在思考", stage: "running" });

  /** `catch` 里抛出来的错误。与投影里的 `error` 事件是两条路，按"后者发生者优先"合。 */
  let failure = "";

  try {
    const handle = await streamChat(
      {
        provider: route.provider,
        model: route.model,
        messages,
        system: fullSystem,
        // 审批档位随请求过界（§143）：模式选择在这侧，工具执行在那侧
        toolPolicy: readConfirmMode(),
        // 只有"回答用户"这条路径才带工具；起标题等附带请求不带（§143）
        useTools: true,
        // 会话日志（C2）：主进程把这一轮完整记下来（请求体 / 事件 / 用量）
        ...(sessionId ? { sessionId } : {}),
      },
      (event) => {
        /*
         * ⭐ **先过投影，再管界面**（C2）：界面只是投影的一种呈现。
         * 反过来的话（先写界面、再"顺便记一下"），两边迟早会漂移 ——
         * 这一侧原来就是这么漂掉的（`done` 里的 usage 没人接）。
         */
        turn = applyEvent(turn, event);

        if (event.type === "text") {
          onPatch({ activity: "正在回复" });
        }
        if (event.type === "tool-call") {
          /*
           * 让用户**当场看见**模型在调工具 —— 否则"记忆被写进去了"是暗箱操作。
           * 文案只说"正在使用"，具体结果等 tool-result 到手再落。
           *
           * 参数不用自己存了：投影里已按 `toolCallId` 配好对（原来这里有个 `inputs` Map）。
           */
          onPatch({ activity: `正在使用${toolLabel(event.toolName)}` });
        }
        if (event.type === "tool-result") {
          /* 「等你确认」还是「正在回复」也取自投影（`pending` 只判一次） */
          const trace = project().traces.find((t) => t.toolCallId === event.toolCallId);
          onPatch({ activity: trace?.pending ? "等你确认" : "正在回复" });
        }
        // error 不在这里处理：投影里记着，收尾时统一取（见下）
      },
    );
    useWorkbenchStore.setState({ runningRequestId: handle.requestId });
    await handle.done;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  useWorkbenchStore.setState({ runningRequestId: null });

  /*
   * 收尾：正文与工具留痕都从投影取。
   *
   * 错误那句话的优先级与原来一致：`catch` 里抛出来的（后发生）盖过 `error` 事件里的。
   */
  const view = project();
  const errorText = failure || view.error || "";
  const text = errorText ? `（出错了）${errorText}` : view.text;
  /*
   * ⚠️ `usage` 一起交出去（C5）：它是 provider 给的**真值**，
   * 原来主进程发了、工作台**没有 `done` 分支**于是直接丢掉（界面那个数一直是按字数估的）。
   * 现在它跟着这一步落盘，显示处据此**如实说明**"上面那个数是估的、真值是这个"。
   *
   * 「默认模型失效、先退回上次」那句跟着返回值出去，由 `answerTurn` 挂到这一步上（§184）
   */
  return {
    text,
    tools: view.traces,
    ...(view.usage ? { usage: view.usage } : {}),
    ...(fellBackNote ? { note: fellBackNote } : {}),
  };
}

/**
 * 处理一段模型输出：能解出提问卡就切到「等待用户」，否则收尾。
 *
 * 收尾前会**把产物提取出来并真的写到磁盘**（阶段 11.1）——
 * 原版的产物是真文件，右侧「对话产物」点开就能看，所以这里不做"只在内存里"的假产物。
 *
 * @param taskId 任务 id
 * @param raw 模型原始输出
 * @param isDoPhase 是否处于第二段（第二段的追问不再无限套娃，只收一次）
 */
/**
 * 把一次模型输出落成一条 AI 回复。
 *
 * @param taskId 归属任务
 * @param raw 模型原始输出
 * @param isDoPhase 是否处于"开始干活"阶段（第一阶段会解析提问块）
 * @param askedWith 这一轮**实际发出去的用户内容**（「重新生成」要原样重跑）
 * @param tools 这一轮用过的工具（§141）；空数组与"没传"等价，都不写字段
 */
function nextStep(
  taskId: string,
  raw: string,
  isDoPhase = false,
  askedWith?: string,
  tools: ToolTrace[] = [],
  /** 这一步额外要说的一句（§149：目前只用于"更早的对话已压缩为摘要"）。 */
  note?: string,
  /** 这一步的**真实用量**（C5）：与界面那个估出来的 `cost` 一起留着，hover 里如实说。 */
  usage?: StepUsage,
): void {
  const state = useWorkbenchStore.getState();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  // 先解提问块（拿正文 + 待问的问题），再从正文里解产物块。
  // 顺序不能反：提问块标记也在正文里，先拆掉它才不会把它的内容当产物。
  const ask = parseAskReply(raw);
  const stepId = makeStepId(task.steps.length + 1);
  const { text, artifacts } = extractArtifacts(
    ask.text,
    taskId,
    Date.now(),
    (i) => `${taskId}-a${i + 1}`,
    stepId,
  );
  const questions = ask.questions;

  const steps = [
    ...task.steps,
    {
      id: stepId,
      role: "assistant" as const,
      text: text || (artifacts.length ? "产物已生成，见右侧「对话产物」。" : "(没有输出内容)"),
      at: Date.now(),
      ...(askedWith ? { askedWith } : {}),
      // 原版会显示「消耗 0.48」（**按额度**，本机没有额度体系）—— 这里按字数估一个同口径可比的数
      cost: fabricatedCost(raw),
      // 真实用量（provider 的 tokens）如实存下来，界面的 hover 里说出来（C5）
      ...(usage ? { usage } : {}),
      // 工具留痕挂在**这一步**上（step 事件化）：哪一步用了什么工具，是从这里读的
      ...(tools.length ? { tools } : {}),
      ...(note ? { note } : {}),
    },
  ];

  if (artifacts.length > 0) {
    useWorkbenchStore.setState({
      tasks: upsertTask(state.tasks, { ...task, steps, artifacts: [...task.artifacts, ...artifacts] }),
    });
    // 落盘是异步的，不挡界面：先让列表出现，再把字节数补上
    void persistArtifacts(taskId, artifacts);
  }

  const withSteps: WorkTask = {
    ...(useWorkbenchStore.getState().tasks.find((t) => t.id === taskId) ?? task),
    steps,
  };

  if (questions.length > 0) {
    useWorkbenchStore.setState({
      tasks: upsertTask(state.tasks, {
        ...withSteps,
        questions: acceptQuestions(questions),
        questionIndex: 0,
        stage: "awaiting",
        activity: "正在询问用户",
      }),
    });
    return;
  }

  // 没解出提问卡：收尾
  useWorkbenchStore.setState({
    tasks: upsertTask(state.tasks, {
      ...withSteps,
      stage: "done",
      finishedAt: Date.now(),
      activity: isDoPhase ? "已完成" : "已完成",
    }),
  });
}

/**
 * 把产物写进磁盘上的产物目录，回填字节数。
 *
 * 文本类产物直接写正文；Office 三类先按 Markdown 落盘（见 HANDOFF §27 的说明：
 * 真正的 docx/pptx/xlsx 生成是下一步，这里不假装已经做到）。
 */
async function persistArtifacts(taskId: string, artifacts: Artifact[]): Promise<void> {
  const bridge = (window as unknown as { shell?: ShellBridge }).shell;
  if (!bridge?.workbench) return;
  for (const artifact of artifacts) {
    try {
      const content = artifact.content ?? "";
      const saved = await bridge.workbench.saveArtifact(artifactFileName(artifact), content);
      useWorkbenchStore.setState((s) => ({
        tasks: s.tasks.map((t) =>
          t.id !== taskId
            ? t
            : {
                ...t,
                artifacts: t.artifacts.map((a) =>
                  a.id === artifact.id ? { ...a, filePath: saved.filePath, bytes: saved.bytes } : a,
                ),
              },
        ),
      }));
    } catch {
      // 落盘失败不影响对话流：界面上那条产物仍然在，只是没有 filePath
    }
  }
}

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
