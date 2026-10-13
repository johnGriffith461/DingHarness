import { app, BrowserWindow } from "electron";
import path from "node:path";

import type { CronJob } from "../../shared/schedule";
import { createJsonStore } from "./jsonStore";

/**
 * 定时任务的持久化（阶段 11.6）。
 *
 * 上位把任务存**服务端**（`/alice/job_cron/*`），本地不留。我们是单机版，
 * 所以落一个 JSON 文件在 userData 下 —— 这样**重启之后任务还在**，
 * 否则"定时"这件事根本不成立。
 *
 * 写入用**临时文件 + rename**：直接写目标文件的话，写到一半断电会留下半个 JSON，
 * 下次启动整个任务列表就没了。rename 在同一分区上是原子的。
 *
 * ── C1（2026-10-13）：落盘收进 `./jsonStore` ──
 *
 * 那手原子写现在由 `./jsonStore` 统一提供，并且**多两条保证**：
 * 写失败重试 3 次（Windows 上"文件被占用"大多是一次性冲突），以及信封带版本。
 *
 * ⚠️ 磁盘上现存的 `schedules.json` 是**裸数组**（没有信封）—— 它会被读成"版本 0"并原样迁上来，
 * 所以升级不会把用户建过的定时任务弄丢（见 `shared/persist.ts` 那条默认）。
 */

/** 通道名。 */
export const SCHEDULE_CHANNEL = {
  load: "schedule:load",
  save: "schedule:save",
  /** 主进程 → 渲染进程：任务变了（§145）。 */
  changed: "schedule:changed",
} as const;

/** 任务文件路径。 */
export function schedulesPath(): string {
  return path.join(app.getPath("userData"), "schedules.json");
}

/**
 * 把不可信的落盘值收窄成任务数组（**与原来那条最小收窄一模一样**）。
 *
 * ⚠️ 只挡到"是个带 id 的对象"为止：字段级收窄在渲染层（`normalizeJobs`，
 * 它才知道缺字段该补什么默认值）。主进程这里收得更狠会把渲染层还能救回来的任务直接丢掉。
 *
 * @param value 落盘的原始值
 * @returns 通过最小收窄的任务数组
 */
function asJobs(value: unknown): CronJob[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is CronJob => Boolean(x) && typeof x === "object" && "id" in x);
}

/**
 * 落盘器（C1）。
 *
 * `file` 是**函数**：`app.getPath("userData")` 在打包前后不同，模块加载期求值会锁死第一次的结果。
 */
const store = createJsonStore<CronJob[]>({
  file: schedulesPath,
  initial: () => [],
  normalize: asJobs,
});

/**
 * 读任务列表。
 * @returns 任务数组；文件不存在或内容坏了都返回空数组（**不让坏文件把应用卡住**）
 */
export async function loadJobs(): Promise<CronJob[]> {
  const got = await store.read();
  // 读不动（磁盘上是更新的版本）只报一声：这里给的是空列表兜底值，应用照常起得来
  if (got.foreign) console.error("[schedule] 磁盘上的定时任务读不动（保留原样）：", got.note);
  return got.data;
}

/**
 * 写任务列表（原子写由 `./jsonStore` 负责）。
 *
 * ⚠️ 磁盘上是**更新的版本**时**拒绝覆盖**（`foreign`）：那是降级运行，
 * 硬写回去等于把用户的定时任务降级销毁 —— 同 §178.6 / §179.6 / §181.6 的取舍。
 *
 * @param jobs 任务数组
 * @returns 是否写成功
 */
export async function saveJobs(jobs: CronJob[]): Promise<boolean> {
  const current = await store.read();
  if (current.foreign) {
    console.error("[schedule] 磁盘上的定时任务版本比本程序新，已拒绝覆盖：", current.note);
    return false;
  }

  const res = await store.write(jobs);
  if (!res.ok) {
    // 原来写失败是一条日志都没有的，用户只会发现"下次运行时间全乱了"
    console.error("[schedule] 落盘失败（重试过）：", res.error);
  }
  return res.ok;
}

/**
 * 注册定时任务 IPC。
 *
 * @param ipcMain Electron 的 ipcMain
 */
export function registerScheduleIpc(ipcMain: Electron.IpcMain): void {
  ipcMain.handle(SCHEDULE_CHANNEL.load, (): Promise<CronJob[]> => loadJobs());
  ipcMain.handle(SCHEDULE_CHANNEL.save, (_event, jobs: CronJob[]): Promise<boolean> =>
    saveJobs(Array.isArray(jobs) ? jobs : []),
  );
}

/**
 * 通知渲染进程"定时任务变了"（§145）。
 *
 * ⚠️ 为什么必须有这条推送：**工具的 `schedule_create` 是在主进程写盘的**，
 * 而渲染进程的调度器（`startScheduler`）用的是**它自己内存里那份列表**。
 * 不通知的话，工具刚建的任务当次会话**不会被跑**，页面也不显示 ——
 * 那就是"看着建好了、其实没用"。
 *
 * 广播给所有窗口（本机版只有一个主窗口，但用广播更省事也更对）。
 */
export function broadcastScheduleChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(SCHEDULE_CHANNEL.changed);
  }
}
