import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";

import { clearMemory, normalizeMemory, type MemoryLib } from "../../shared/memory";

/**
 * 「记忆」的落盘。
 *
 * 与 `driveStore` / `scheduleStore` 同一个形态：一个 userData 下的 json 文件 +
 * 两个 IPC（读 / 存）。**读回时一律过一遍 `normalizeMemory`** ——
 * 磁盘上的东西不可信（§49 那次"加完能用、重启就没了"就是漏了这层）。
 *
 * 为什么不做成"一条一个 IPC"（list/clear/delete 三条）：
 * 本体的那三条路由是**服务端接口**，本地版没必要拆 ——
 * 一次读写整个库，既少一次往返，也避免"部分写入"这种半截状态。
 */

/** IPC 通道名（preload 与主进程共用，避免两边写错字符串）。 */
export const MEMORY_CHANNEL = {
  read: "memory:read",
  write: "memory:write",
  clear: "memory:clear",
} as const;

const FILE = "memory.json";

/**
 * 记忆库文件路径。
 *
 * @returns 绝对路径
 */
function filePath(): string {
  return path.join(app.getPath("userData"), FILE);
}

/**
 * 读回记忆库。
 *
 * @returns 合法的库（文件不存在或坏了则给空库）
 */
export function readMemory(): MemoryLib {
  try {
    return normalizeMemory(JSON.parse(fs.readFileSync(filePath(), "utf8")));
  } catch {
    /* 首次运行没有文件、或文件坏了 —— 都给空库，让应用能起来 */
    return normalizeMemory(null);
  }
}

/**
 * 写回记忆库。
 *
 * 单独抽出来是因为**有两个调用方**：渲染进程的 IPC，以及主进程里的工具执行（§141）。
 * 两处必须走同一条落盘路径（含 `normalizeMemory` 规整与建目录），
 * 否则工具写进去的东西 IPC 读出来会不一样。
 */
export function writeMemory(next: unknown): MemoryLib {
  const lib = normalizeMemory(next);
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(lib, null, 2), "utf8");
  return lib;
}

/**
 * 注册记忆相关的 IPC。
 *
 * @returns 解除注册的函数
 */
export function registerMemoryIpc(): () => void {
  ipcMain.handle(MEMORY_CHANNEL.read, () => readMemory());

  ipcMain.handle(MEMORY_CHANNEL.write, (_event, next: unknown) => writeMemory(next));

  ipcMain.handle(MEMORY_CHANNEL.clear, () => writeMemory(clearMemory()));

  return () => {
    for (const ch of Object.values(MEMORY_CHANNEL)) ipcMain.removeHandler(ch);
  };
}
