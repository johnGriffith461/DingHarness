import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 工作台任务的持久化（阶段 11.9）。
 *
 * ## 为什么这件非做不可
 * 任务原先只在渲染进程内存里，**重启就全没了** —— 于是：
 *   · 「最近」每次打开都是空的，而原版的会话历史是持久的；
 *   · 置顶与项目**看着能用其实是空的**（库里存着 id，但没有任何任务与之对应）。
 * 换句话说，少了这一层，前面做的置顶/项目/产物只是"当次会话内有效"。
 *
 * ## 与画布快照同一套口径
 * 临时文件 + rename 原子写；读失败返回空数组（**不让坏文件把应用卡住**）。
 * 收窄放在渲染层 —— 任务的数据形状由它定义。
 */

/** 通道名。 */
export const TASK_CHANNEL = {
  load: "task:load",
  save: "task:save",
} as const;

/** 任务文件路径。 */
export function tasksPath(): string {
  return path.join(app.getPath("userData"), "tasks.json");
}

/**
 * 读任务。
 * @returns 数组；文件不存在或内容坏了都返回空数组
 */
export async function loadTasks(): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(tasksPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 写任务（原子写）。
 *
 * @param tasks 任务数组
 * @returns 是否写成功
 */
export async function saveTasks(tasks: unknown[]): Promise<boolean> {
  const target = tasksPath();
  const temp = `${target}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(Array.isArray(tasks) ? tasks : [], null, 2), "utf8");
    await fs.rename(temp, target);
    return true;
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    return false;
  }
}

/**
 * 注册任务 IPC。
 *
 * @param ipcMain Electron 的 ipcMain
 */
export function registerTaskIpc(ipcMain: Electron.IpcMain): void {
  ipcMain.handle(TASK_CHANNEL.load, (): Promise<unknown[]> => loadTasks());
  ipcMain.handle(TASK_CHANNEL.save, (_event, tasks: unknown[]): Promise<boolean> =>
    saveTasks(Array.isArray(tasks) ? tasks : []),
  );
}
