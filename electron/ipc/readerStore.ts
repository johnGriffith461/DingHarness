import { app, ipcMain } from "electron";
import path from "node:path";

import { normalizeReadings, type Reading } from "../../shared/reader";
import { createJsonStore } from "./jsonStore";

/**
 * 「最近阅读」的落盘（§155）。
 *
 * 与 `docStore` / `memoryStore` 同一个形态：userData 下一个 json + 两个 IPC。
 * **读回时过 `normalizeReadings`**（磁盘不可信，且顺手做条数上限，
 * 免得这个文件随着阅读次数一直涨）。
 *
 * ── C1（2026-10-13）：落盘收进 `./jsonStore` ──
 *
 * 那手原子写现在由 `./jsonStore` 统一提供。这里的收窄**顺手做了截断**
 * （`normalizeReadings` 默认只留最近 20 条），所以 `normalize` 传的就是它 ——
 * 迁移完读回来的东西一样会被压到上限内。
 *
 * ⚠️ 磁盘上现存的 `readings.json` 是**裸数组**（没有信封）—— 会被读成"版本 0"并原样迁上来。
 */

export const READER_CHANNEL = {
  load: "reader:load",
  save: "reader:save",
} as const;

const FILE = "readings.json";

function filePath(): string {
  return path.join(app.getPath("userData"), FILE);
}

/** 落盘器（C1：原子写 + 重试 + 信封版本，全部在 `./jsonStore` 里一份）。 */
const store = createJsonStore<Reading[]>({
  file: filePath,
  initial: () => [],
  normalize: (value) => normalizeReadings(value),
});

/** 读回最近阅读。 */
export async function loadReadings(): Promise<Reading[]> {
  const got = await store.read();
  // 读不动（磁盘上是更新的版本）只报一声：这里给的是空列表兜底值，界面照常起得来
  if (got.foreign) console.error("[reader] 磁盘上的最近阅读读不动（保留原样）：", got.note);
  return got.data;
}

/**
 * 写回最近阅读（原子写由 `./jsonStore` 负责）。
 *
 * ⚠️ 磁盘上是**更新的版本**时**拒绝覆盖**（`foreign`）：那是降级运行，
 * 硬写回去等于把用户的阅读记录降级销毁 —— 同 §178.6 / §179.6 / §181.6 的取舍。
 *
 * @param next 任意值（会被规整）
 * @returns 规整之后真正落盘的内容
 */
export async function saveReadings(next: unknown): Promise<Reading[]> {
  const readings = normalizeReadings(next);

  const current = await store.read();
  if (current.foreign) {
    console.error("[reader] 磁盘上的最近阅读版本比本程序新，已拒绝覆盖：", current.note);
    return readings;
  }

  const res = await store.write(readings);
  if (!res.ok) {
    // 原来写失败是一条日志都没有的，用户只会发现"最近阅读又空了"
    console.error("[reader] 落盘失败（重试过）：", res.error);
  }
  return readings;
}

/**
 * 注册相关 IPC。
 *
 * @returns 解除注册的函数
 */
export function registerReaderIpc(): () => void {
  ipcMain.handle(READER_CHANNEL.load, () => loadReadings());
  ipcMain.handle(READER_CHANNEL.save, (_event, next: unknown) => saveReadings(next));
  return () => {
    for (const ch of Object.values(READER_CHANNEL)) ipcMain.removeHandler(ch);
  };
}
