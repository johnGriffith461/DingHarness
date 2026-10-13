import { create } from "zustand";
import type { ShellBridge } from "@shared/ipc";
import {
  afterRun,
  dueJobs,
  makeJob,
  nextRunAt,
  normalizeJobs,
  validateJob,
  type CronJob,
  type RepeatType,
  type RunEnv,
} from "@shared/schedule";

/**
 * 定时任务的状态与调度器（阶段 11.6）。
 *
 * ## 调度是**真的在跑**
 * 每 20 秒 tick 一次，把到点的任务交给 `runJob`。`runJob` 不是打个日志 ——
 * 它**建一个真实的工作台任务**（走同一条 AI 通道），执行完把成功/失败记进历史。
 *
 * ## 为什么 ticker 放在渲染层
 * 主进程只管存取（`schedules.json`）。把调度放渲染层有两个好处：
 * 任务真正执行时要复用渲染层已有的任务 store 与 AI 通道，放主进程就得再造一套；
 * 而任务数据本身**已经持久化在磁盘上**，所以窗口重开不丢。
 * 代价是关掉窗口就不跑了 —— 这跟"本机没开就没法跑"的直觉一致，也如实写在界面上。
 */

/** 检查间隔。太短没必要（最小间隔都是 5 分钟），太长会让"立刻执行"显得迟钝。 */
const TICK_MS = 20_000;

type ScheduleState = {
  jobs: CronJob[];
  loaded: boolean;
  /** 正在执行的任务 id（界面显示"执行中"）。 */
  runningId: string | null;
  note: string;

  /** 从磁盘载入。 */
  load: () => Promise<void>;
  /** 新建。返回错误说明；成功返回 null。 */
  create: (draft: {
    title: string;
    prompt: string;
    repeat: RepeatType;
    env: RunEnv;
    customMinutes?: number;
  }) => string | null;
  /**
   * 改一个已有任务（阶段 11.27）。
   *
   * 原来只能删了重建 —— 想改个间隔就得丢掉执行历史，很别扭。
   *
   * @param id 任务 id
   * @param draft 新的字段
   * @returns 错误说明；成功返回 null
   */
  update: (
    id: string,
    draft: { title: string; prompt: string; repeat: RepeatType; env: RunEnv; customMinutes?: number },
  ) => string | null;
  /** 暂停 / 继续。 */
  toggle: (id: string) => void;
  /** 删除。 */
  remove: (id: string) => void;
  /** 立刻执行一次（不等到点）。 */
  runNow: (id: string) => Promise<void>;
  /** 由 ticker 调用：跑到点的任务。 */
  tick: () => Promise<void>;
};

/** 取 shell 桥。 */
function bridge(): ShellBridge | undefined {
  return (globalThis as unknown as { shell?: ShellBridge }).shell;
}

let seq = 0;

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  jobs: [],
  loaded: false,
  runningId: null,
  note: "",

  load: async () => {
    const shell = bridge();
    if (!shell?.schedules) {
      set({ loaded: true, note: "定时任务通道不可用：请用 Electron 启动应用" });
      return;
    }
    /*
     * ⚠️ 必须先归一化再当 CronJob 用（§178）：原来这里是一句 `as CronJob[]`
     * 直接断言，然后直接解引用字段 —— 一个手改过的 schedules.json
     * （repeat 写成别的词、nextRunAt 是字符串）就能把界面与 ticker 一起搞乱。
     */
    const raw = normalizeJobs(await shell.schedules.load());
    /*
     * 补算 nextRunAt：任务在磁盘上可能已经"该跑了"（上次关窗口时还没到点）。
     * 直接把过期的 nextRunAt 留着会让 ticker 一启动就补跑一堆 —— 那不对。
     * 所以：**过期的一律顺延到下一个整周期**，只保留真正未来的那个时间。
     */
    const now = Date.now();
    const jobs = raw.map((job) => {
      const next = job.nextRunAt;
      if (job.status !== "running" || next === null) return job;
      if (next > now) return job;
      const shifted = nextRunAt({ ...job, lastRunAt: next }, now);
      return { ...job, nextRunAt: shifted };
    });
    set({ jobs, loaded: true, note: "" });
  },

  create: (draft) => {
    const error = validateJob(draft);
    if (error) return error;
    const job = makeJob(
      `job${Date.now().toString(36)}${(seq += 1)}`,
      draft.title,
      draft.prompt,
      draft.repeat,
      draft.env,
      Date.now(),
      draft.customMinutes,
    );
    const jobs = [job, ...get().jobs];
    set({ jobs, note: "" });
    void persist(jobs);
    return null;
  },

  update: (id, draft) => {
    const error = validateJob(draft);
    if (error) return error;
    const now = Date.now();
    const jobs = get().jobs.map((job) => {
      if (job.id !== id) return job;
      const next: CronJob = {
        ...job,
        title: draft.title.trim(),
        prompt: draft.prompt.trim(),
        repeat: draft.repeat,
        env: draft.env,
        // 换回非自定义档时把分钟数清掉，免得下次切回来还留着旧值
        customMinutes: draft.repeat === "custom" ? draft.customMinutes : undefined,
      };
      /*
       * 改了时间就得**重算下次执行**，否则界面会显示一个按旧设置算出来的时间。
       *
       * 顺带把已结束的任务拉回 running：用户刚改了执行时间，
       * 意图显然是"让它按新时间跑"，而不是"改完继续躺着不跑"。
       * 执行历史保留 —— 那是这个任务已经干过的事，不该因为改设置就抹掉。
       */
      next.status = "running";
      next.nextRunAt = nextRunAt(next, now);
      return next;
    });
    set({ jobs, note: "" });
    void persist(jobs);
    return null;
  },

  toggle: (id) => {
    const jobs = get().jobs.map((job) => {
      if (job.id !== id) return job;
      if (job.status === "running") {
        return { ...job, status: "paused" as const, nextRunAt: null };
      }
      // 继续：从当前时间重新排下次，不补跑暂停期间错过的
      return { ...job, status: "running" as const, nextRunAt: nextRunAt({ ...job, status: "running" }, Date.now()) };
    });
    set({ jobs });
    void persist(jobs);
  },

  remove: (id) => {
    const jobs = get().jobs.filter((job) => job.id !== id);
    set({ jobs });
    void persist(jobs);
  },

  runNow: async (id) => {
    // 用户主动点的「立刻执行」→ 前台跑，跳到任务页看结果（这是他要的反馈）
    await execute(id, get, set, false);
  },

  tick: async () => {
    const due = dueJobs(get().jobs, Date.now());
    for (const job of due) {
      // 一个一个跑：并行跑多个任务会把 AI 通道与用户注意力一起打满
      await execute(job.id, get, set);
    }
  },
}));

/**
 * 执行一个任务：**真的建一个工作台任务**，再把结果记进历史。
 *
 * @param id 任务 id
 * @param get store 的读
 * @param set store 的写
 * @param background 是否后台执行（不抢焦点 —— ticker 触发时为 true）
 */
async function execute(
  id: string,
  get: () => ScheduleState,
  set: (patch: Partial<ScheduleState>) => void,
  background = true,
): Promise<void> {
  const job = get().jobs.find((j) => j.id === id);
  if (!job || get().runningId) return;

  set({ runningId: id, note: `正在执行「${job.title}」…` });
  let ok = true;
  let error: string | undefined;
  try {
    // 动态引：避免 schedule ↔ workbench store 的循环依赖
    const { useWorkbenchStore } = await import("./store");
    await useWorkbenchStore.getState().createTask(job.prompt, { background });
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message : String(e);
  }

  const now = Date.now();
  const jobs = get().jobs.map((j) => (j.id === id ? afterRun(j, now, ok, error) : j));
  set({ jobs, runningId: null, note: ok ? `「${job.title}」执行完成` : `「${job.title}」执行失败：${error}` });
  void persist(jobs);
}

/**
 * 写回磁盘。
 * 写失败只提示，不抛 —— 定时任务不该因为存盘失败把界面搞崩。
 */
async function persist(jobs: CronJob[]): Promise<void> {
  const shell = bridge();
  if (!shell?.schedules) return;
  const ok = await shell.schedules.save(jobs);
  if (!ok) useScheduleStore.setState({ note: "任务已改，但存盘失败（重启后可能丢失）" });
}

/** ticker 的句柄（只允许一个，避免热更新后堆出多个定时器）。 */
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动调度器（幂等）。
 * @returns 停止函数
 */
export function startScheduler(): () => void {
  if (timer) clearInterval(timer);
  void useScheduleStore.getState().load().then(() => useScheduleStore.getState().tick());

  /*
   * 主进程改了任务就重新读一次（§145）。
   *
   * 起因：工具的 `schedule_create` 在**主进程**写盘，而这里的调度器用的是**内存里那份列表**。
   * 不订阅的话，工具刚建的任务当次会话不会被跑、页面也不显示 ——
   * "看着建好了、其实没用"。返回的取消订阅函数在下面的清理里一起调。
   */
  const stopWatch = bridge()?.schedules?.onChanged?.(() => {
    void useScheduleStore.getState().load();
  });
  timer = setInterval(() => {
    void useScheduleStore.getState().tick();
  }, TICK_MS);
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    // 一并退订变更通知（不退订的话：热更新 / 重新挂载会累积监听器）
    stopWatch?.();
  };
}
