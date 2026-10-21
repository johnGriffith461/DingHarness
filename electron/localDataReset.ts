import fs from "node:fs";
import path from "node:path";

/**
 * **「清空本机数据」的落盘部分**（M-08）。
 *
 * ## 为什么是"下次启动时清"
 *
 * Windows 上应用正在跑的 SQLite（`sessions.db` / `stores.db`）与 Chromium 的
 * `Local Storage` 都占着文件句柄 —— 运行时删会 EPERM，或者留下半截数据。
 * 所以 UI 点完只写一个标记文件，**重启后在打开任何 store 之前**执行清理。
 *
 * ## 删什么、不删什么
 *
 * 删：会话库、KV 库（设置/任务/记忆等都在里面）、画布快照、顶层 JSON、
 * 渲染层 localStorage（模型启用清单）。
 * **不删**：`secrets.dat`（密钥，界面文案明确写了不在其中）、`boot.log`、
 * `crashes.jsonl`（排障证据）。
 */

export const RESET_MARKER = ".reset-pending";

const KEEP = new Set([RESET_MARKER, "secrets.dat", "boot.log", "crashes.jsonl", ".DS_Store"]);
const DIRS = new Set(["canvas", "Local Storage", "Session Storage"]);

/**
 * 如果有待处理的重置标记，就把本机数据清掉。
 *
 * @param dir userData 目录
 * @returns `applied:false` = 没有标记（正常启动）
 */
export function applyPendingReset(dir: string): { applied: boolean; removed: string[] } {
  const marker = path.join(dir, RESET_MARKER);
  if (!fs.existsSync(marker)) return { applied: false, removed: [] };

  const removed: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { applied: false, removed: [] };
  }

  for (const entry of entries) {
    if (KEEP.has(entry.name)) continue;
    const target = path.join(dir, entry.name);
    const isStoreDb = /^stores\.db(?:-wal|-shm)?$/.test(entry.name);
    const isSessionDb = /^sessions\.db(?:-wal|-shm)?$/.test(entry.name);
    const isTopJson = entry.isFile() && entry.name.endsWith(".json");
    const isKnownDir = entry.isDirectory() && DIRS.has(entry.name);
    if (!isStoreDb && !isSessionDb && !isTopJson && !isKnownDir) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      /* 删不掉就留着（下次启动再试不了 —— 标记会被移除；如实给 boot.log 之外的人看不到） */
    }
  }

  try {
    fs.rmSync(marker, { force: true });
  } catch {
    /* 标记删不掉：下次启动会再清一遍（幂等） */
  }
  return { applied: true, removed };
}
