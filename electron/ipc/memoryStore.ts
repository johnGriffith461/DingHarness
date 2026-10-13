import { app, ipcMain } from "electron";
import path from "node:path";

import { clearMemory, normalizeMemory, type MemoryLib } from "../../shared/memory";
import { createJsonStore } from "./jsonStore";

/**
 * 「记忆」的落盘。
 *
 * 与 `driveStore` / `scheduleStore` 同一个形态：一个 userData 下的 json 文件 +
 * 几个 IPC（读 / 存 / 清）。**读回时一律过一遍 `normalizeMemory`** ——
 * 磁盘上的东西不可信（§49 那次"加完能用、重启就没了"就是漏了这层）。
 *
 * 为什么不做成"一条一个 IPC"（list/clear/delete 三条）：
 * 本体的那三条路由是**服务端接口**，本地版没必要拆 ——
 * 一次读写整个库，既少一次往返，也避免"部分写入"这种半截状态。
 *
 * ── C1（2026-10-13）：这个文件是全仓**唯一漏了原子写**的那个 ──
 *
 * 原来是裸的 `fs.writeFileSync(filePath(), JSON.stringify(lib, null, 2))`：
 * 断电或崩溃正好落在写的中途，磁盘上就是**半截 JSON** ——
 * 而读回时 `JSON.parse` 抛错被 catch 成"空库"，表现是**用户的东西全没了**。
 *
 * 现在收进 `./jsonStore`（临时文件 + rename 原子写、写失败重试 3 次、信封带版本）。
 * 顺带把 API 变成异步：落盘要重试就不可能同步，而同步重试会**卡住主进程**（就是卡住整个界面）。
 * 调用方只有两处（IPC 与 `tools.ts` 的工具执行），都已经能 await。
 *
 * ⚠️ 磁盘上现存的 `memory.json` 是**裸 JSON**（没有信封）—— 它会被读成"版本 0"并原样迁上来，
 * 所以升级不会丢已有的记忆（见 `shared/persist.ts` 里那条默认，以及它的单测）。
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

/** 落盘器（C1：原子写 + 重试 + 信封版本，全部在 `./jsonStore` 里一份）。 */
const store = createJsonStore<MemoryLib>({
  file: filePath,
  initial: () => normalizeMemory(null),
  normalize: (value) => normalizeMemory(value),
});

/**
 * 读回记忆库。
 *
 * @returns 合法的库（文件不存在或坏了则给空库）
 */
export async function readMemory(): Promise<MemoryLib> {
  const got = await store.read();
  if (got.foreign) console.error("[memory] 磁盘上的记忆库读不动（保留原样）：", got.note);
  return got.data;
}

/**
 * 写回记忆库。
 *
 * 单独抽出来是因为**有两个调用方**：渲染进程的 IPC，以及主进程里的工具执行（§141）。
 * 两处必须走同一条落盘路径（含 `normalizeMemory` 规整与建目录），
 * 否则工具写进去的东西 IPC 读出来会不一样。
 *
 * ⚠️ 磁盘上是**更新的版本**时（`foreign`）**拒绝覆盖** —— 那是降级运行，
 * 硬写回去等于把用户的数据降级销毁。宁可这次没存上并记一条日志。
 *
 * @param next 要写的东西（会被 `normalizeMemory` 规整）
 * @returns 规整后的库
 */
export async function writeMemory(next: unknown): Promise<MemoryLib> {
  const lib = normalizeMemory(next);

  const current = await store.read();
  if (current.foreign) {
    console.error("[memory] 磁盘上的记忆库版本比本程序新，已拒绝覆盖：", current.note);
    return lib;
  }

  const res = await store.write(lib);
  if (!res.ok) {
    // 写失败不再静默：原来这里连日志都没有，用户只会发现"重启后东西没了"
    console.error("[memory] 落盘失败（重试过）：", res.error);
  }
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
