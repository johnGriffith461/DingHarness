import { app, ipcMain } from "electron";
import path from "node:path";

import { normalizeDocs, type Doc } from "../../shared/doc";
import { createJsonStore } from "./jsonStore";

/**
 * AI 文档的落盘（§153）。
 *
 * 与 `memoryStore` / `driveStore` / `scheduleStore` 同一个形态：
 * userData 下一个 json 文件 + 两个 IPC（读 / 存）。
 * **读回时一律过 `normalizeDocs`** —— 磁盘上的东西不可信。
 *
 * 为什么不做成"一篇一个 IPC"：一次读写整库，既少往返，
 * 也避免"写过一半"这种半截状态（本体的那几条是服务端接口，本地版没必要拆）。
 *
 * ── C1（2026-10-13）：落盘收进 `./jsonStore` ──
 *
 * 那手"临时文件 + rename"现在由 `./jsonStore` 统一提供，并且**多两条保证**：
 * 写失败重试 3 次（Windows 上"文件被占用"大多是一次性冲突，不重试就是丢数据），
 * 以及信封带版本 —— 文档的形状（版本列表 / 标题 / 附件）真变了才有地方挂迁移。
 *
 * ⚠️ 磁盘上现存的 `docs.json` 是**裸数组**（没有信封）—— 它会被读成"版本 0"并原样迁上来。
 * 这条是硬要求：文档是用户自己写的东西，读不出来比"少个功能"严重得多。
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

/** 落盘器（C1：原子写 + 重试 + 信封版本，全部在 `./jsonStore` 里一份）。 */
const store = createJsonStore<Doc[]>({
  file: filePath,
  initial: () => [],
  normalize: (value) => normalizeDocs(value),
});

/**
 * 读回文档库。
 *
 * @returns 合法文档列表（文件不存在或坏了都给空列表，让应用能起来）
 */
export async function loadDocs(): Promise<Doc[]> {
  const got = await store.read();
  // 读不动（磁盘上是更新的版本）只报一声：这里给的是空列表兜底值，界面照常起得来
  if (got.foreign) console.error("[doc] 磁盘上的文档读不动（保留原样）：", got.note);
  return got.data;
}

/**
 * 写回文档库（原子写由 `./jsonStore` 负责）。
 *
 * ⚠️ 磁盘上是**更新的版本**时**拒绝覆盖**（`foreign`）：那是降级运行，
 * 硬写回去等于把用户写的文档降级销毁 —— 同 §178.6 / §179.6 / §181.6 的取舍：宁可这次没存上。
 *
 * @param next 任意值（会被规整）
 * @returns 规整之后真正落盘的内容
 */
export async function saveDocs(next: unknown): Promise<Doc[]> {
  const docs = normalizeDocs(next);

  const current = await store.read();
  if (current.foreign) {
    console.error("[doc] 磁盘上的文档版本比本程序新，已拒绝覆盖：", current.note);
    return docs;
  }

  const res = await store.write(docs);
  if (!res.ok) {
    // 原来写失败是一条日志都没有的，用户只会发现"刚写的文档没了"
    console.error("[doc] 落盘失败（重试过）：", res.error);
  }
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
