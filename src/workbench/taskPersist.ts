/**
 * 任务持久化（阶段 11.9 / C6-4 Step 2）：从磁盘恢复、把变化落盘。
 *
 * ## 为什么单独一个文件
 *
 * 这一段原来长在 `store.ts` 里（1296 行那个巨石）。搬出来之后它**不再直接摸 store** ——
 * 需要的那点能力（读 state / 写 state / 订阅）由调用方按 `StorePort` 注入。
 * 依赖方向因此是单向的：`store.ts → taskPersist.ts → task.ts`；
 * 本模块对 store 只有 `import type`（编译后完全擦除），**环结构上不可能成立**。
 *
 * ## 状态只有一个家
 *
 * `saveQueue` / `saveTimer` 是**这一个模块**的模块级状态 —— 搬家时它们跟着搬过来。
 * 别在 store.ts 或别处再声明一份：两份 = 写盘竞态，而且从现象上几乎看不出来。
 */
import type { ShellBridge } from "@shared/ipc";
import { CONTEXT_INDEX_VERSION, type ContextIndex } from "@engine/core/contextManager";
import { interruptedFromStage } from "@engine/core/recovery";
import { INTERRUPTED_NOTE, normalizeArtifacts, normalizeQuestions, normalizeStep, type WorkTask } from "./task";
import type { StorePort } from "./store";

/**
 * 恢复上下文索引（磁盘按不可信处理）。
 *
 * 版本不认识就给 null（**不猜**旧格式的字段）：索引是接力棒，
 * 拿一份读不懂的索引去续写比没有索引更危险。
 */
function normalizeContextIndex(raw: unknown): ContextIndex | null {
  if (!raw || typeof raw !== "object") return null;
  const i = raw as Record<string, unknown>;
  if (i.version !== CONTEXT_INDEX_VERSION) return null;
  if (typeof i.sessionId !== "string" || typeof i.goal !== "string") return null;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  const anchor = (i.anchor ?? {}) as Record<string, unknown>;
  return {
    version: CONTEXT_INDEX_VERSION,
    sessionId: i.sessionId,
    goal: i.goal,
    decisions: strings(i.decisions),
    openItems: strings(i.openItems),
    artifacts: strings(i.artifacts),
    anchor: {
      seq: typeof anchor.seq === "number" && Number.isFinite(anchor.seq) ? Math.max(0, Math.floor(anchor.seq)) : 0,
      eventCount:
        typeof anchor.eventCount === "number" && Number.isFinite(anchor.eventCount)
          ? Math.max(0, Math.floor(anchor.eventCount))
          : 0,
    },
    createdAt: typeof i.createdAt === "number" && Number.isFinite(i.createdAt) ? i.createdAt : 0,
  };
}

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
   * ⚠️ 只有 `running` 算"中断"（§179）—— 判据取自引擎（审计 P139 / P211）。
   *
   * `awaiting` **不是**进行中 —— 它等的是**用户回答**，不是某个请求。
   * 原来把两者一起标成 `failed`，后果很具体：
   * 界面上澄清卡只在 `stage === "awaiting"` 时渲染 →
   * **重启之后那张卡永远不出现，用户再也回答不了那个问题**，
   * 而那一次对话就卡在那里了（它不是坏了，是在等人）。
   *
   * ⚠️ 用了 `interruptedFromStage` 而不是在这里手写 `stage === "running"`：
   * 桌面端那颗「继续」按钮（`task.ts` 的 `continueTargetOf`）看的是这同一件事。
   * 判据住 `engine/core/recovery.ts`，两处不再各判一次。
   *
   * 这与本项目"闸门/审批的意义就是用户看得见并决定"是同一条：
   * **在等人的状态不该被系统自己判死。**
   */
  const interrupted = interruptedFromStage(stage);
  const contextIndex = normalizeContextIndex(t.contextIndex);
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
    stage: interrupted ? "failed" : (stage as WorkTask["stage"]),
    startedAt: typeof t.startedAt === "number" ? t.startedAt : null,
    finishedAt: typeof t.finishedAt === "number" ? t.finishedAt : interrupted ? Date.now() : null,
    steps,
    questions,
    questionIndex: typeof t.questionIndex === "number" ? t.questionIndex : 0,
    /* 说明是给人看的（`INTERRUPTED_NOTE` 一处定义），判据是真值字段 `interrupted` */
    activity: interrupted ? INTERRUPTED_NOTE : typeof t.activity === "string" ? t.activity : "",
    artifacts,
    /* 最近访问的时刻（P266）：它是真值，恢复时照收（老数据没这个字段就不带） */
    ...(typeof t.openedAt === "number" ? { openedAt: t.openedAt } : {}),
    /*
     * 「那一轮被打断了吗」的真值，随任务落盘 —— 界面那颗「继续」按钮只看它
     * （`task.ts` 的 `continueTargetOf`）。**不写成 `false` 的默认**：
     * 只有真被打断过才落这个字段，没被恢复过的任务身上不该多一个字段。
     */
    ...(interrupted ? { interrupted: true } : {}),
    /* ICM（V6-1c）：压缩次数与索引都是真值；老任务没有就不带，不编 0 次/空索引 */
    ...(typeof t.contextCompactions === "number" && t.contextCompactions > 0
      ? { contextCompactions: Math.floor(t.contextCompactions) }
      : {}),
    ...(contextIndex ? { contextIndex } : {}),
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
export async function restoreTasks(port: StorePort): Promise<string[]> {
  const bridge = (globalThis as unknown as { shell?: ShellBridge }).shell;
  if (!bridge?.tasks) return [];
  const raw = await bridge.tasks.load();
  const tasks = raw.map(normalizeTask).filter((t): t is WorkTask => t !== null);
  if (tasks.length === 0) return [];
  port.setState({
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
function schedulePersist(port: StorePort): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!saveTimer) return;
    saveTimer = null;
    const bridge = (globalThis as unknown as { shell?: ShellBridge }).shell;
    if (!bridge?.tasks) return;
    /*
     * 落盘前剥掉流式草稿（`draft`）：它每几十毫秒变一次，写进磁盘纯属浪费；
     * 而且它不该跨重启活下来（被中断的那一步会被标成 failed，草稿留着自相矛盾）。
     */
    /*
   * 落盘前剥掉两份**只属于这一次会话**的东西：
   *   · `draft` —— 流式草稿，每几十毫秒变一次
   *   · `material` —— 随这轮带的资料正文（最多 3×12000 字），
   *     `tasks.json` 是"任务账本"，不该被几万字的资料正文撑起来；
   *     重启后要重新添加（`normalizeTask` 也不认它）
   */
  const tasks = port
    .getState()
    .tasks.map((t) =>
      t.draft === undefined && t.material === undefined ? t : { ...t, draft: undefined, material: undefined },
    );
    saveQueue = saveQueue.then(() => bridge.tasks.save(tasks)).catch(() => undefined);
  }, 600);
}

/**
 * 开始监听任务变化并持久化。
 * @returns 停止函数
 */
export function startTaskPersistence(port: StorePort): () => void {
  const unsubscribe = port.subscribe((state, prev) => {
    if (state.tasks !== prev.tasks) schedulePersist(port);
  });
  return () => {
    unsubscribe();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  };
}
