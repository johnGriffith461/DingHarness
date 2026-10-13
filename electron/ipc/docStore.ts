import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";

import { normalizeDocs, type Doc } from "../../shared/doc";

/**
 * AI 文档的落盘（§153）。
 *
 * 与 `memoryStore` / `driveStore` / `scheduleStore` 同一个形态：
 * userData 下一个 json 文件 + 两个 IPC（读 / 存）。
 * **读回时一律过 `normalizeDocs`** —— 磁盘上的东西不可信。
 *
 * 为什么不做成"一篇一个 IPC"：一次读写整库，既少往返，
 * 也避免"写过一半"这种半截状态（本体的那几条是服务端接口，本地版没必要拆）。
 */

/** IPC 通道名（preload 与主进程共用，避免两边写错字符串）。 */
export const DOC_CHANNEL = {
  load: "doc:load",
  save: "doc:save",
} as const;

const FILE = "docs.json";

/** 文档库文件路径。 */
function filePath(): string {
  return path.join(app.getPath("userData"), FILE);
}

/**
 * 读回文档库。
 *
 * @returns 合法文档列表（文件不存在或坏了都给空列表，让应用能起来）
 */
export function loadDocs(): Doc[] {
  try {
    return normalizeDocs(JSON.parse(fs.readFileSync(filePath(), "utf8")));
  } catch {
    return [];
  }
}

/**
 * 写回文档库（临时文件 + rename，与其余几个 store 一致：写到一半断电不留半个 JSON）。
 *
 * @param next 任意值（会被规整）
 * @returns 规整之后真正落盘的内容
 */
export function saveDocs(next: unknown): Doc[] {
  const docs = normalizeDocs(next);
  const dir = path.dirname(filePath());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(docs, null, 2), "utf8");
  fs.renameSync(tmp, filePath());
  return docs;
}

/**
 * 注册文档相关的 IPC。
 *
 * @returns 解除注册的函数
 */
export function registerDocIpc(): () => void {
  ipcMain.handle(DOC_CHANNEL.load, () => loadDocs());
  ipcMain.handle(DOC_CHANNEL.save, (_event, next: unknown) => saveDocs(next));
  return () => {
    for (const ch of Object.values(DOC_CHANNEL)) ipcMain.removeHandler(ch);
  };
}
