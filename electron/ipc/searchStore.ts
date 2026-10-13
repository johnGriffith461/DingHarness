import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";

import { normalizeHistory, type SearchHistory } from "../../shared/searchHistory";

/**
 * 搜索历史的落盘（§162）。
 *
 * ⚠️ **为什么不用 `localStorage`**：§156 撞过 —— localStorage 是**延迟落盘**的，
 * 强杀进程/断电时缓冲区随进程一起丢。搜索历史是"用户觉得它一直在"的东西，
 * 重启就空会显得像坏了。所以走这里的**同步原子写**。
 */

export const SEARCH_HISTORY_CHANNEL = {
  load: "searchHistory:load",
  save: "searchHistory:save",
} as const;

const FILE = "search-history.json";

function filePath(): string {
  return path.join(app.getPath("userData"), FILE);
}

/** 读回搜索历史。 */
export function loadSearchHistory(): SearchHistory {
  try {
    return normalizeHistory(JSON.parse(fs.readFileSync(filePath(), "utf8")));
  } catch {
    return normalizeHistory(null);
  }
}

/**
 * 写回搜索历史（临时文件 + rename）。
 *
 * @param next 任意值（会被规整）
 * @returns 规整之后真正落盘的内容
 */
export function saveSearchHistory(next: unknown): SearchHistory {
  const history = normalizeHistory(next);
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  const tmp = `${filePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2), "utf8");
  fs.renameSync(tmp, filePath());
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
