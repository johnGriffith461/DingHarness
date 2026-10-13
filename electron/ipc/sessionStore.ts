import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

import { parseLog, logLine, type LogInput, type LogRecord } from "../../shared/sessionLog";
import { retryAsync } from "../../shared/persist";

/**
 * 会话事件日志的落盘（C2）。
 *
 * ## 为什么要有它（而不是只靠 `tasks.json`）
 *
 * 现在落盘的只有渲染层那份"任务/消息数组"（`electron/ipc/taskStore.ts`），
 * 它是**渲染后的样子**：工具输出被折成一行小字、`pending` 只剩一个标记、
 * usage 直接丢了。于是"**模型这一轮到底看见了什么**"在事后**重建不出来** ——
 * 而上下文压缩（C3）、真实用量（C5）、"谁批的"审计（INV-3）全都要靠这件事。
 *
 * 这个文件记的是**事件本身**（一行一条），不加工、不折行。
 *
 * ## 两条与 C1 一致、但形态不同的要求
 *
 * - **追加写**：不是"整文件覆盖 + 信封"（那是 `jsonStore` 的形态）。
 *   一次会话的事件是连续增长的，每次重写整个文件既慢又危险。一行一条时
 *   **坏掉的只是那一行**（`parseLog` 会跳过它并在坏行数里报出来）。
 * - **写失败要重试**：与 C1 同一条理由（Windows 上"文件被占用"大多是一次性冲突）。
 *   所以这里也走 `retryAsync`。
 *
 * ## ⚠️ 安全：会话 id 是**渲染进程给的**
 *
 * 它要当文件名用，所以必须收窄成 `[A-Za-z0-9._-]`（并拒掉以 `.` 开头的）
 * —— 否则 `../../` 这种 id 能把日志写到 userData 之外（`safeSessionId`）。
 * 收不窄就直接**不记日志**，不报错、不影响对话本身。
 */

/** 日志目录（在最外层 `sessions/` 下，便于整目录清理）。 */
function sessionsDir(): string {
  return path.join(app.getPath("userData"), "sessions");
}

/**
 * 会话 id 收窄。
 *
 * @param raw 渲染进程给的 id（不可信）
 * @returns 可安全当文件名的 id；不合法返回 null
 */
export function safeSessionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(id)) return null;
  // `..` 由上面的正则已经排掉（不含连续点也不以点开头），这里只是把意图写明白
  if (id.includes("..")) return null;
  return id;
}

/**
 * 某个会话的日志文件路径。
 *
 * @param sessionId 会话 id（会被收窄）
 * @returns 绝对路径；id 不合法返回 null
 */
export function sessionLogPath(sessionId: unknown): string | null {
  const id = safeSessionId(sessionId);
  return id ? path.join(sessionsDir(), `${id}.jsonl`) : null;
}

/** 一个会话的写入器。 */
export type SessionLogger = {
  /** 记一条记录（**同步入队**：调用方不必 await，顺序不会乱）。 */
  log: (record: LogInput) => void;
  /** 等已入队的写入全部落盘（验收与排错用）。 */
  flush: () => Promise<void>;
  /** 已记了几条（验收断言"日志行数 = 事件数"时用）。 */
  count: () => number;
  /** 日志文件路径（给人看/给验收读）。 */
  file: string;
};

/**
 * 建一个会话日志写入器。
 *
 * 写入**串行化**（内部一条 promise 链）：并发追加同一文件虽然多数情况没事，
 * 但顺序就成了运气 —— 而日志的价值恰恰在顺序。
 *
 * ⚠️ 写失败**不抛给调用方**：对话本身不该因为"日志写不进去"而失败（磁盘满、
 * 目录被占）。失败会打一条错误日志，并让 `flush()` 的 promise 以成功收尾
 * （否则 `void` 掉它会产生 unhandled rejection）。
 *
 * @param sessionId 会话 id（渲染进程给的，会被收窄）
 * @returns 写入器；id 不合法时返回 null（调用方据此跳过记日志）
 */
export function createSessionLogger(sessionId: unknown): SessionLogger | null {
  const file = sessionLogPath(sessionId);
  if (!file) return null;

  let seq = 0;
  let queue: Promise<void> = Promise.resolve();
  /** 目录建过一次就够（文本按 ~40ms 一批发，每次都 `mkdir` 是白花的系统调用）。 */
  let dirReady = false;

  const append = async (line: string): Promise<void> => {
    try {
      if (!dirReady) {
        await mkdir(path.dirname(file), { recursive: true });
        dirReady = true;
      }
      await retryAsync(async () => appendFile(file, line, "utf8"));
    } catch (error) {
      console.error("[session] 日志写入失败（不影响对话）：", error instanceof Error ? error.message : error);
    }
  };

  return {
    file,
    log: (record) => {
      seq += 1;
      const line = logLine(record, seq, Date.now());
      queue = queue.then(() => append(line));
    },
    flush: () => queue,
    count: () => seq,
  };
}

/**
 * 读回一个会话的事件日志。
 *
 * ⚠️ 坏行**只跳过它自己**（`parseLog` 负责），并把跳过数报出来 ——
 * "写入被打断"不该让整段历史消失，也不该被静默吞掉。
 *
 * @param sessionId 会话 id
 * @returns 记录（含首行 `request`）与坏行数；文件不存在时给空（第一次跑是正常的）
 */
export async function readSessionLog(sessionId: unknown): Promise<{ records: LogRecord[]; skipped: number }> {
  const file = sessionLogPath(sessionId);
  if (!file) return { records: [], skipped: 0 };
  try {
    const text = await readFile(file, "utf8");
    return parseLog(text);
  } catch {
    /* 文件不存在 / 读不了：都当"还没有日志"，不算错误 */
    return { records: [], skipped: 0 };
  }
}
