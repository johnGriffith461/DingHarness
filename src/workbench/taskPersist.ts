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
import { normalizeArtifacts, normalizeQuestions, normalizeStep, type WorkTask } from "./task";
import type { StorePort } from "./store";

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
    const tasks = port.getState().tasks;
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
