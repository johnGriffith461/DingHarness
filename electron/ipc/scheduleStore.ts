import { app, BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { CronJob } from "../../shared/schedule";

/**
 * 定时任务的持久化（阶段 11.6）。
 *
 * 上位把任务存**服务端**（`/alice/job_cron/*`），本地不留。我们是单机版，
 * 所以落一个 JSON 文件在 userData 下 —— 这样**重启之后任务还在**，
 * 否则"定时"这件事根本不成立。
 *
 * 写入用**临时文件 + rename**：直接写目标文件的话，写到一半断电会留下半个 JSON，
 * 下次启动整个任务列表就没了。rename 在同一分区上是原子的。
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
 * 读任务列表。
 * @returns 任务数组；文件不存在或内容坏了都返回空数组（**不让坏文件把应用卡住**）
 */
export async function loadJobs(): Promise<CronJob[]> {
  try {
    const raw = await fs.readFile(schedulesPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // 只做最小收窄：字段不全会由渲染层的默认值兜住
    return parsed.filter((x): x is CronJob => Boolean(x) && typeof x === "object" && "id" in x);
  } catch {
    return [];
  }
}

/**
 * 写任务列表（原子写）。
 *
 * @param jobs 任务数组
 * @returns 是否写成功
 */
export async function saveJobs(jobs: CronJob[]): Promise<boolean> {
  const target = schedulesPath();
  const temp = `${target}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(jobs, null, 2), "utf8");
    await fs.rename(temp, target);
    return true;
  } catch {
    // 写失败不留残file
    await fs.rm(temp, { force: true }).catch(() => undefined);
    return false;
  }
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
