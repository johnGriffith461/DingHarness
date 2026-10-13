import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";

import { normalizeReadings, type Reading } from "../../shared/reader";

/**
 * 「最近阅读」的落盘（§155）。
 *
 * 与 `docStore` / `memoryStore` 同一个形态：userData 下一个 json + 两个 IPC。
 * **读回时过 `normalizeReadings`**（磁盘不可信，且顺手做条数上限，
 * 免得这个文件随着阅读次数一直涨）。
 */

export const READER_CHANNEL = {
  load: "reader:load",
  save: "reader:save",
} as const;

const FILE = "readings.json";

function filePath(): string {
  return path.join(app.getPath("userData"), FILE);
}

/** 读回最近阅读。 */
export function loadReadings(): Reading[] {
  try {
    return normalizeReadings(JSON.parse(fs.readFileSync(filePath(), "utf8")));
  } catch {
    return [];
  }
}

/**
 * 写回最近阅读（临时文件 + rename，与其余 store 一致）。
 *
 * @param next 任意值（会被规整）
 * @returns 规整之后真正落盘的内容
 */
export function saveReadings(next: unknown): Reading[] {
  const readings = normalizeReadings(next);
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  const tmp = `${filePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(readings, null, 2), "utf8");
  fs.renameSync(tmp, filePath());
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
