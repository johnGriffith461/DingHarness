import fs from "node:fs";
import path from "node:path";
import { app, ipcMain } from "electron";

import { loadTasks } from "./taskStore";
import { desktopSessionStore } from "./sessionStore";
import { listWorkspaces } from "./workspaceStore";
import { RESET_MARKER } from "../localDataReset";

/**
 * **本机数据**（M-08）：路径可见、可清空。
 *
 * 设置 → 通用 → 本机数据：
 * 1. 显示**真实**的 userData 路径（`app.getPath("userData")`，不是拼出来的）；
 * 2. 「清空本机数据」先报数（会话 / 任务 / 授权目录），确认后写标记并重启，
 *    重启时在打开 store 之前清理（见 `../localDataReset.ts`）。
 *
 * ⚠️ 密钥不在清空范围（在 `secrets.dat` / `~/.ding`）—— 文案必须说清。
 */

export const LOCAL_DATA_CHANNEL = {
  summary: "localData:summary",
  reset: "localData:reset",
} as const;

export type LocalDataSummary = {
  dataDir: string;
  sessions: number;
  tasks: number;
  workspaces: number;
};

export async function localDataSummary(): Promise<LocalDataSummary> {
  let sessions = 0;
  let tasks = 0;
  let workspaces = 0;
  try {
    sessions = (await desktopSessionStore().list()).length;
  } catch {
    /* 读不出来就报 0（旁边会显示"可能读不到"由调用方决定，不编数） */
  }
  try {
    tasks = (await loadTasks()).length;
  } catch {
    /* 同上 */
  }
  try {
    workspaces = (await listWorkspaces()).dirs.length;
  } catch {
    /* 同上 */
  }
  return { dataDir: app.getPath("userData"), sessions, tasks, workspaces };
}

/** 写标记 + 重启（干净启动时执行真正的删除）。 */
export function requestLocalDataReset(): { ok: true } {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, RESET_MARKER), new Date().toISOString(), "utf8");
  /*
   * 给 IPC 回执留一点时间再重启 —— 立刻 `app.exit()` 会让渲染层收到"连接断开"，
   * 用户看到的是一个莫名其妙的错误，而不是"正在重启"。
   */
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 400);
  return { ok: true };
}

export function registerLocalDataIpc(): void {
  ipcMain.handle(LOCAL_DATA_CHANNEL.summary, () => localDataSummary());
  ipcMain.handle(LOCAL_DATA_CHANNEL.reset, () => requestLocalDataReset());
}
