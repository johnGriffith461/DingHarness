import { app } from "electron";
import path from "node:path";

import { createJsonStore } from "./jsonStore";

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
 *
 * ── C1（2026-10-13）：落盘收进 `./jsonStore` ──
 *
 * 那手原子写现在由 `./jsonStore` 统一提供，并且**多两条保证**：
 * 写失败重试 3 次（Windows 上"文件被占用"大多是一次性冲突，不重试就是丢数据），
 * 以及信封带版本 —— 以后任务的形状真变了，才有地方挂迁移。
 *
 * ⚠️ 磁盘上现存的 `tasks.json` 是**裸数组**（没有信封）—— 它会被读成"版本 0"并原样迁上来。
 * 这一条是硬要求：任务里挂着置顶 / 项目成员 / 产物，"读不出来"就等于把这些全清空
 * （见 `shared/persist.ts` 那条默认，以及它的单测）。
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
 * 落盘器（C1）。
 *
 * `normalize` 只做"是不是数组"这一层收窄 —— 与原来读回时的判断一字不差，
 * 因为**任务的形状由渲染层定义**（它才知道旧任务缺哪个字段该补什么默认值）；
 * 主进程收得更狠，就等于替渲染层把还没放弃的旧任务丢掉。
 *
 * `file` 是**函数**：`app.getPath("userData")` 在打包前后不同，模块加载期求值会锁死第一次的结果。
 */
const store = createJsonStore<unknown[]>({
  file: tasksPath,
  initial: () => [],
  normalize: (value) => (Array.isArray(value) ? value : []),
});

/**
 * 读任务。
 * @returns 数组；文件不存在或内容坏了都返回空数组
 */
export async function loadTasks(): Promise<unknown[]> {
  const got = await store.read();
  // 读不动（磁盘上是更新的版本）只报一声：这里给的是空数组兜底值，界面照常起得来
  if (got.foreign) console.error("[task] 磁盘上的任务列表读不动（保留原样）：", got.note);
  return got.data;
}

/**
 * 写任务（原子写由 `./jsonStore` 负责）。
 *
 * ⚠️ 磁盘上是**更新的版本**时**拒绝覆盖**（`foreign`）：那是降级运行，
 * 硬写回去等于把用户的任务（连同置顶 / 项目 / 产物）降级销毁 ——
 * 同 §178.6 / §179.6 / §181.6 的取舍：宁可这次没存上。
 *
 * @param tasks 任务数组
 * @returns 是否写成功
 */
export async function saveTasks(tasks: unknown[]): Promise<boolean> {
  const current = await store.read();
  if (current.foreign) {
    console.error("[task] 磁盘上的任务列表版本比本程序新，已拒绝覆盖：", current.note);
    return false;
  }

  const res = await store.write(Array.isArray(tasks) ? tasks : []);
  if (!res.ok) {
    // 原来写失败是一条日志都没有的，用户只会发现"重启后最近又空了"
    console.error("[task] 落盘失败（重试过）：", res.error);
  }
  return res.ok;
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
