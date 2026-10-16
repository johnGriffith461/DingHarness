import { app, ipcMain } from "electron";
import path from "node:path";

import { normalizeHistory, type SearchHistory } from "../../shared/searchHistory";
import { createJsonStore } from "./jsonStore";

/**
 * 搜索历史的落盘（§162）。
 *
 * ⚠️ **为什么不用 `localStorage`**：§156 撞过 —— localStorage 是**延迟落盘**的，
 * 强杀进程/断电时缓冲区随进程一起丢。搜索历史是"用户觉得它一直在"的东西，
 * 重启就空会显得像坏了。所以走主进程的原子写。
 *
 * ── C1（2026-10-13）：落盘收进 `./jsonStore` ──
 *
 * 那手"临时文件 + rename"现在由 `./jsonStore` 统一提供。这里的收窄**顺手做了去重与条数上限**
 * （`normalizeHistory` 的 `HISTORY_LIMIT`），所以 `normalize` 传的就是它。
 *
 * ⚠️ 磁盘上现存的 `search-history.json` 是**裸对象**（没有信封）—— 会被读成"版本 0"并原样迁上来。
 */

export const SEARCH_HISTORY_CHANNEL = {
  load: "searchHistory:load",
  save: "searchHistory:save",
} as const;

const FILE = "search-history.json";

function filePath(): string {
  return path.join(app.getPath("userData"), FILE);
}

/** 落盘器（C1：原子写 + 重试 + 信封版本，全部在 `./jsonStore` 里一份）。 */
const store = createJsonStore<SearchHistory>({
  file: filePath,
  initial: () => normalizeHistory(null),
  normalize: (value) => normalizeHistory(value),
});

/** 读回搜索历史。 */
export async function loadSearchHistory(): Promise<SearchHistory> {
  const got = await store.read();
  // 读不动（磁盘上是更新的版本）只报一声：这里给的是空历史兜底值，界面照常起得来
  if (got.foreign) console.error("[search] 磁盘上的搜索历史读不动（保留原样）：", got.note);
  return got.data;
}

/**
 * 写回搜索历史（原子写由 `./jsonStore` 负责）。
 *
 * ⚠️ 磁盘上是**更新的版本**时**拒绝覆盖**（`foreign`）：那是降级运行，
 * 硬写回去等于把用户的历史降级销毁 —— 同 §178.6 / §179.6 / §181.6 的取舍。
 *
 * ⚠️ **审计 P223**：写盘真失败时**抛错**，不再"打个日志、照样返回成功值"。
 * 原来写失败仍 `return history`，`ipcMain.handle` 正常 resolve，渲染层收不到失败信号。
 *
 * @param next 任意值（会被规整）
 * @returns 规整之后真正落盘的内容
 * @throws 落盘失败（重试过仍失败）时抛，让那次 IPC 明确 reject
 */
export async function saveSearchHistory(next: unknown): Promise<SearchHistory> {
  const history = normalizeHistory(next);

  const current = await store.read();
  if (current.foreign) {
    console.error("[search] 磁盘上的搜索历史版本比本程序新，已拒绝覆盖：", current.note);
    return history;
  }

  const res = await store.write(history);
  if (!res.ok) {
    // 原来写失败是一条日志都没有的，用户只会发现"搜过的词又没了"
    console.error("[search] 落盘失败（重试过）：", res.error);
    throw new Error(`搜索历史落盘失败：${res.error}`);
  }
  return history;
}

/**
 * 注册相关 IPC。
 *
 * @returns 解除注册的函数
 */
export function registerSearchHistoryIpc(): () => void {
  ipcMain.handle(SEARCH_HISTORY_CHANNEL.load, () => loadSearchHistory());
  ipcMain.handle(SEARCH_HISTORY_CHANNEL.save, (_event, next: unknown) => saveSearchHistory(next));
  return () => {
    for (const ch of Object.values(SEARCH_HISTORY_CHANNEL)) ipcMain.removeHandler(ch);
  };
}
