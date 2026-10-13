import { create, type StoreApi } from "zustand";
import type { ShellBridge } from "@shared/ipc";
import { runToolOnce } from "../ai/aiClient";
import { buildAskPrompt, buildDoPrompt, describeAnswer, parseAskReply } from "./agent";
import { extractArtifacts } from "./artifact";
import {
  rejectedLine,
  type ToolTrace,
} from "@shared/agentTools";
import { taskSessionId } from "@shared/sessionLog";
import { fabricatedCost } from "@shared/cost";
import { branchFrom, planRewind, resolveRewindTarget } from "./checkpoint";
import { readConfirmMode } from "./confirmMode";
import { pickSuggestions, SUGGESTION_POOL } from "./copy";
import {
  restoreTasks as restoreTasksIn,
  startTaskPersistence as startTaskPersistenceIn,
} from "./taskPersist";
import {
  abortRunning,
  answerTurn,
  nextStep,
  persistArtifacts,
  refineTitle,
  runStream,
} from "./taskRuntime";
import {
  answerQuestion,
  autoTaskTitle,
  current,
  makeStepId,
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

/** 工作台里的一个"页面"。 */
export type WorkbenchView = "home" | "task" | "scheduled" | "plugins" | "cloud" | "phone" | "threads" | "doc" | "center" | "reader" | "agent" | "coding" | "image" | "video";

export type WorkbenchState = {
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
  createTask: (message: string, options?: { background?: boolean; material?: string }) => Promise<void>;
  /** 在已有对话里继续说一句（§147）—— 与 `createTask` 的区别是带上历史。 */
  sendInTask: (taskId: string, message: string, options?: { material?: string }) => Promise<void>;
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
    const { system } = buildDoPrompt(task.brief, background, task.material);
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

  /**
   * 中止当前任务。
   *
   * 动作体整段搬去 `taskRuntime.ts` 的 `abortRunning`（C6-4 Step 3）：`activeHandle`
   * 只由 `runStream` 写，"怎么中止这条流"要和"谁持有它"待在一起。
   */
  abort: () => abortRunning(port),

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
  sendInTask: async (taskId, message, options) => {
    const text = String(message ?? "").trim();
    if (!text) return;

    const state = get();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;

    const now = Date.now();
    const withNew: WorkTask = {
      ...task,
      /* 这一轮带的资料（没给就沿用任务上原来那份）—— 与"先问再干"那条路的口径一致。 */
      ...(options?.material ?? task.material ? { material: options?.material ?? task.material } : {}),
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
    await answerTurn(port, taskId, task.steps, text, undefined, withNew.material);
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
    await answerTurn(port, taskId, plan.kept.slice(0, -1), plan.reask, "已回到这一步重新回答", task.material);
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
    const material = options?.material;
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

    const { system, user } = buildAskPrompt(text, [], material);
    const reply = await runStream(
      port,
      user,
      system,
      (patch) => {
        set((s) => ({ tasks: upsertTask(s.tasks, { ...current(s.tasks, task.id), ...patch }) }));
      },
      [],
      task.id,
    );

    nextStep(port, task.id, reply.text, false, user, reply.tools, undefined, reply.usage);
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
    const { system, user } = buildDoPrompt(advanced.brief, background, advanced.material);
    const reply = await runStream(
      port,
      user,
      system,
      (patch) => {
        set((s) => ({ tasks: upsertTask(s.tasks, { ...current(s.tasks, advanced.id), ...patch }) }));
      },
      [],
      advanced.id,
    );

    // 第二段如果又吐了提问块，也照收（模型有时会追问，原版也允许）
    nextStep(port, advanced.id, reply.text, true, user, reply.tools, undefined, reply.usage);
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
