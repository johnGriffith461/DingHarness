import { app } from "electron";
/* ⚠️ 要 `node:fs/promises`（不是 `node:fs`）—— 这个文件里全是 `await` 的写法 */
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeLiked } from "../../shared/coding";

/**
 * 「喜欢」的落盘（§180）。
 *
 * ## 为什么必须落盘
 *
 * §156 那次的教训：**localStorage 是懒刷的，硬杀进程就没了**。
 * 喜欢这种东西关掉窗口再打开就消失，用户会觉得"点了没用"。
 *
 * ## 形状
 *
 * `{"liked": ["应用名", ...]}` —— 只有名字，**没有点赞数**
 * （本体那个数字是跨用户热度，本机编不出来，详见 `shared/coding.ts`）。
 */

/** IPC 通道名（preload 与主进程共用）。 */
export const CODING_CHANNEL = {
  read: "coding:readLiked",
  write: "coding:writeLiked",
} as const;

/** 喜欢名单的文件路径。 */
export function codingLikesPath(): string {
  return path.join(app.getPath("userData"), "coding-likes.json");
}

/**
 * 读喜欢名单。
 *
 * @returns 干净的名字列表；文件不存在或坏了都给空名单（**不让坏文件把应用卡住**）
 */
export async function loadLiked(): Promise<string[]> {
  try {
    const raw = await fs.readFile(codingLikesPath(), "utf8");
    // ⚠️ 读回一律过一遍归一化（§178 的规矩）：磁盘上的东西不可信
    return normalizeLiked(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

/**
 * 写喜欢名单（原子写：先写 `.tmp` 再 rename）。
 *
 * @param liked 名字列表
 * @returns 是否写成功
 */
export async function saveLiked(liked: unknown): Promise<boolean> {
  const target = codingLikesPath();
  const temp = `${target}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temp, JSON.stringify({ liked: normalizeLiked({ liked }) }, null, 2), "utf8");
    await fs.rename(temp, target);
    return true;
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    return false;
  }
}

/**
 * 注册本机侧 IPC。
 *
 * @param ipc Electron 的 `ipcMain`
 */
export function registerCodingIpc(ipc: Electron.IpcMain): void {
  ipc.handle(CODING_CHANNEL.read, () => loadLiked());
  ipc.handle(CODING_CHANNEL.write, (_event, liked: unknown) => saveLiked(liked));
}
