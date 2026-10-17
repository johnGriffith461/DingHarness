import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isEnvelope, wrap } from "../../shared/persist";
import { normalizeJobs, type CronJob } from "../../shared/schedule";

/**
 * 定时任务的落盘（V6-2g）：**与桌面共用同一个文件**。
 *
 * 桌面那条路（`electron/ipc/scheduleStore.ts`）写的是
 * `<userData>/schedules.json`，格式是 `{__schema, data}` 信封（旧数据是裸数组）。
 * CLI 要能读同一份、写回同一份 —— 否则"桌面建的定时任务，CLI 守护进程看不见"，
 * 而"关掉窗口就停"这个问题就还是没解。
 *
 * 分工：
 * - **桌面**：界面负责建/改/展示；调度在渲染层（关窗即停是已知限制）。
 * - **CLI**：`ding schedule run-due --every N` 常驻执行；不改界面状态。
 *
 * 两边同时写同一个文件时，原子写（tmp + rename）保证不会留半截 JSON；
 * 后写覆盖先写（没有并发锁）—— 单机单用户下这与现有其它 JSON store 的口径一致。
 */

/** 任务文件（与桌面同一个名字）。 */
export function schedulesFile(dataDir: string): string {
  return path.join(dataDir, "schedules.json");
}

/**
 * 读任务。
 *
 * @param dataDir 数据目录
 * @returns 合法任务（文件不在/坏了都给空数组，不抛）
 */
export function readJobs(dataDir: string): CronJob[] {
  const file = schedulesFile(dataDir);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const data = isEnvelope(raw) ? raw.data : raw;
    return normalizeJobs(data);
  } catch {
    return [];
  }
}

/**
 * 写任务（原子）。
 *
 * @param dataDir 数据目录
 * @param jobs 任务
 * @returns 文件路径
 */
export function writeJobs(dataDir: string, jobs: readonly CronJob[]): string {
  const file = schedulesFile(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(wrap([...jobs]), null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return file;
}
