import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 本机库的持久化（阶段 11.7 / 11.8）：装过的插件、项目、置顶、收藏。
 *
 * 与定时任务同一套做法：**临时文件 + rename 原子写**。
 * 这个文件比任务列表更常被改（装一次就写一次），所以原子性更要紧 ——
 * 写坏的后果是"插件全没了 / 项目全没了"，用户会以为应用出了问题。
 *
 * **收窄放在渲染层**（`normalizeLibrary`）：主进程只管存取字节，
 * 因为它不知道当前目录里有哪些 id、哪些任务还活着 —— 那两样都只有渲染层清楚。
 */

/** 通道名。 */
export const LIBRARY_CHANNEL = {
  load: "library:load",
  save: "library:save",
} as const;

/** 库文件路径。 */
export function libraryPath(): string {
  return path.join(app.getPath("userData"), "library.json");
}

/**
 * 读库。
 * @returns 原始 JSON；文件不存在或内容坏了都返回空对象（**不让坏文件把应用卡住**）
 */
export async function loadLibrary(): Promise<unknown> {
  try {
    const raw = await fs.readFile(libraryPath(), "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/**
 * 写库（原子写）。
 *
 * @param value 要写的值
 * @returns 是否写成功
 */
export async function saveLibrary(value: unknown): Promise<boolean> {
  const target = libraryPath();
  const temp = `${target}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(value ?? {}, null, 2), "utf8");
    await fs.rename(temp, target);
    return true;
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    return false;
  }
}

/**
 * 注册本机库 IPC。
 *
 * @param ipcMain Electron 的 ipcMain
 */
export function registerLibraryIpc(ipcMain: Electron.IpcMain): void {
  ipcMain.handle(LIBRARY_CHANNEL.load, (): Promise<unknown> => loadLibrary());
  ipcMain.handle(LIBRARY_CHANNEL.save, (_event, value: unknown): Promise<boolean> => saveLibrary(value));
}
