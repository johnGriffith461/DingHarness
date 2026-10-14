import { app, dialog, ipcMain, type BrowserWindow } from "electron";
import path from "node:path";

import {
  MAX_WORKSPACES,
  emptyWorkspaces,
  normalizeWorkspaces,
  type WorkspaceList,
} from "../../shared/workspace";
import { createJsonStore } from "./jsonStore";

/**
 * 工作区（用户授权给 agent 的目录）的落盘与 IPC（2026-10-14）。
 *
 * ## 两条硬规矩
 *
 * ① **`workspace:add` 不接受渲染进程给的路径** —— 它只认系统目录选择器的返回。
 *    理由很直接：如果渲染层能传任意路径，那"用户授权"这道手续就是假的
 *    （一个被注入的渲染进程就能把整个磁盘加进白名单）。
 *    所以这里没有"加一个指定路径"的接口，测试要验授权后的效果也只能靠**预置落盘文件**
 *    （脚本直接把 `workspaces.json` 写进隔离数据目录 —— 这与"用户点过选择器"等价，
 *    因为我们验的是"授权之后 agent 能不能干活"，不是"对话框长什么样"）。
 *
 * ② **内存里有一份同步缓存**，`ownedDirs()` 直接读它（那个函数是同步的、
 *    被每个工具调用）。缓存由启动时的 `loadWorkspaces()` 填、由 add/remove 更新 ——
 *    不存在"磁盘变了但工具还按旧白名单跑"的窗口（除非进程外有人改文件，见 `refresh`）。
 */

export const WORKSPACE_CHANNEL = {
  list: "workspace:list",
  add: "workspace:add",
  remove: "workspace:remove",
} as const;

const FILE = "workspaces.json";

function filePath(): string {
  return path.join(app.getPath("userData"), FILE);
}

/** 落盘器（C1：原子写 + 重试 + 信封版本）。 */
const store = createJsonStore<WorkspaceList>({
  file: filePath,
  initial: () => emptyWorkspaces(),
  normalize: (value) => normalizeWorkspaces(value),
});

/*
 * 同步缓存：`ownedDirs()` 是同步函数（每个工具都调），不能 await。
 * 启动时 `loadWorkspaces()` 填一次，之后 add/remove 就地更新。
 */
let cache: string[] = [];

/** 现在已授权的目录（同步；给 `ownedDirs()` 与工具用）。 */
export function workspaceDirsSync(): string[] {
  return [...cache];
}

/** 从磁盘读一次并刷新缓存。 */
export async function loadWorkspaces(): Promise<WorkspaceList> {
  const got = await store.read();
  if (got.foreign) console.error("[workspace] 磁盘上的授权列表读不动（保留原样，不覆盖）：", got.note);
  cache = got.data.dirs;
  return got.data;
}

/** 读当前列表（给界面）。 */
export async function listWorkspaces(): Promise<WorkspaceList> {
  return { dirs: workspaceDirsSync() };
}

/** 写回（磁盘上是更新版本时拒绝覆盖 —— 同其它 store 的取舍）。 */
async function save(next: WorkspaceList): Promise<WorkspaceList> {
  const current = await store.read();
  if (current.foreign) {
    console.error("[workspace] 磁盘上的授权列表版本比本程序新，已拒绝覆盖：", current.note);
    return { dirs: workspaceDirsSync() };
  }
  const res = await store.write(next);
  if (!res.ok) console.error("[workspace] 落盘失败（重试过）：", res.error);
  cache = next.dirs;
  return next;
}

/**
 * 弹目录选择器并授权。
 *
 * @param win 父窗口（模态挂在它上面）
 * @returns 选中的目录（取消则 `dir: null`）
 */
export async function addWorkspaceFromDialog(win: BrowserWindow | null): Promise<{ dir: string | null; list: WorkspaceList }> {
  const picked = win
    ? await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "选择要让 agent 干活的文件夹" })
    : await dialog.showOpenDialog({ properties: ["openDirectory"], title: "选择要让 agent 干活的文件夹" });
  if (picked.canceled || !picked.filePaths.length) return { dir: null, list: { dirs: workspaceDirsSync() } };

  const dir = picked.filePaths[0];
  /*
   * 只认绝对路径（选择器本来就只给绝对路径，这里是防御性的一手：
   * 将来若有别的调用方，也不该能把相对路径塞进白名单）。
   */
  if (!path.isAbsolute(dir)) return { dir: null, list: { dirs: workspaceDirsSync() } };

  const current = workspaceDirsSync();
  if (current.some((d) => d.toLowerCase() === dir.toLowerCase())) {
    return { dir, list: { dirs: current } };
  }
  if (current.length >= MAX_WORKSPACES) {
    return { dir: null, list: { dirs: current } };
  }
  const next = await save({ dirs: [...current, dir] });
  return { dir, list: next };
}

/**
 * 撤销一个已有授权。
 *
 * @param dir 要撤销的目录（必须**已经在列表里** —— 不接受凭空指定，避免变成"任意写"的口子）
 * @returns 撤销之后的列表
 */
export async function removeWorkspace(dir: string): Promise<WorkspaceList> {
  const target = String(dir ?? "").trim().toLowerCase();
  const current = workspaceDirsSync();
  if (!current.some((d) => d.toLowerCase() === target)) return { dirs: current };
  return await save({ dirs: current.filter((d) => d.toLowerCase() !== target) });
}

/**
 * 注册 IPC。
 *
 * @param getWin 取当前主窗口（对话框要挂在它上面）
 * @returns 解除注册
 */
export function registerWorkspaceIpc(getWin: () => BrowserWindow | null): () => void {
  ipcMain.handle(WORKSPACE_CHANNEL.list, () => listWorkspaces());
  ipcMain.handle(WORKSPACE_CHANNEL.add, () => addWorkspaceFromDialog(getWin()));
  ipcMain.handle(WORKSPACE_CHANNEL.remove, (_e, dir: string) => removeWorkspace(dir));
  return () => {
    for (const ch of Object.values(WORKSPACE_CHANNEL)) ipcMain.removeHandler(ch);
  };
}
