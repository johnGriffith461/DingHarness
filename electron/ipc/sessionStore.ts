import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

import {
  conversationIdOf,
  conversationTitle,
  isChatSessionId,
  logLine,
  parseLog,
  type LogInput,
  type LogRecord,
} from "../../shared/sessionLog";
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

/** IPC 通道名（preload 与主进程共用）。 */
export const SESSION_CHANNEL = {
  /** 列聊天会话（F3：重启后把对话列表恢复出来）。 */
  list: "session:list",
  /** 读回一整段会话的记录（渲染层自己投影成消息）。 */
  load: "session:load",
} as const;

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

  /**
   * `seq` 从**已有文件的末号**接着数（惰性、只算一次）。
   *
   * ## 为什么必须这样（真验收抓到的）
   *
   * `seq` 是"这条记录在**这个文件**里的位置"，而文件是**跨进程**的：
   * 用户重启应用、或者在重启之后点「允许」，写入方是**新的进程**。
   * 每个进程从 1 开始数的话，新记录会与旧记录**撞号** ——
   * 读回来按 `seq` 排序时，"批准"会排到它对应的那一轮**前面**，
   * 于是回溯找不到那条留痕、那条留痕永远是"等确认"
   * （实测：`accept-chathistory` 第二次重启后按钮还在）。
   */
  const ready = (async () => {
    const { records } = await readRecords(file);
    seq = records.reduce((max, r) => Math.max(max, r.seq), 0);
  })();

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
    flush: () => queue,
    count: () => seq,
    log: (record) => {
      // 写与计数都在**同一条队列**里：编号顺序 = 落盘顺序
      queue = queue
        .then(() => ready)
        .then(async () => {
          seq += 1;
          await append(logLine(record, seq, Date.now()));
        });
    },
  };
}

/**
 * 取一个会话的写入器（**同一会话共用一个**）。
 *
 * ## 为什么必须有这个"共用"
 *
 * `seq` 是**每个文件**的位置编号，不是每个写入器的。而同一个会话会被**多处**写入：
 * 一轮对话由 `ai:chat` 写（request/事件），用户点「允许」之后由 `ai:runTool` 写决策记录 ——
 * 那是**另一个**调用点。如果各自 `createSessionLogger`（各自从 1 开始数），
 * 后写的记录会带着**已经用过的 seq** 落进同一个文件：读回来按 seq 排序时，
 * "批准"就会排到它对应的那一轮**前面去**（表现是重启后那条留痕又变成"等确认"）。
 *
 * ⚠️ 进程内缓存，不淘汰：本机版同时开着的会话是**个位数**，而淘汰带来的
 * "同一个文件两个计数器"正是这里要避免的事。
 *
 * @param sessionId 会话 id（渲染进程给的，会被收窄）
 * @returns 该会话的写入器；id 不合法时 null（调用方据此跳过记日志）
 */
const loggers = new Map<string, SessionLogger>();

export function getSessionLogger(sessionId: unknown): SessionLogger | null {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  const existing = loggers.get(id);
  if (existing) return existing;
  const created = createSessionLogger(id);
  if (created) loggers.set(id, created);
  return created;
}

/** 一个会话在列表里的样子（F3：界面的会话列表从日志重建）。 */
export type SessionSummary = {
  /** 日志 id（`chat-<对话 id>`）。 */
  sessionId: string;
  /** 对话 id（界面用的那个）。 */
  conversationId: string;
  /** 标题（取第一条 request 里最后一条用户消息的第一行）。 */
  title: string;
  /** 最后写入时间（epoch ms）——列表按它倒序。 */
  updatedAt: number;
  bytes: number;
};

/** 读一个文件并解析（内部共用；坏行只跳过它自己）。 */
async function readRecords(file: string): Promise<{ records: LogRecord[]; skipped: number }> {
  try {
    return parseLog(await readFile(file, "utf8"));
  } catch {
    /* 文件不存在 / 读不了：都当"还没有日志"，不算错误 */
    return { records: [], skipped: 0 };
  }
}

/**
 * 列出**聊天**会话（F3）。
 *
 * ⚠️ 只列聊天会话：工作台任务也往同一个目录写日志（前缀 `task-`），
 * 而任务的"恢复"走的是 `tasks.json` 那条路 —— 混进来会让聊天侧多出一堆假对话。
 *
 * @returns 会话摘要，按最后写入时间倒序（最近的在前面）
 */
export async function listChatSessions(): Promise<SessionSummary[]> {
  let names: string[] = [];
  try {
    names = await readdir(sessionsDir());
  } catch {
    return []; // 目录还没建过 = 还没有任何会话
  }
  const out: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (!isChatSessionId(sessionId) || !safeSessionId(sessionId)) continue;
    const full = path.join(sessionsDir(), name);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) continue;
    const { records } = await readRecords(full);
    out.push({
      sessionId,
      conversationId: conversationIdOf(sessionId),
      title: conversationTitle(records),
      updatedAt: info.mtimeMs,
      bytes: info.size,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 注册会话日志 IPC（F3）。
 *
 * ⚠️ 只回**记录**，不回"投影好的消息"：投影是纯函数（`shared/sessionLog.ts`），
 * 渲染层自己调就行 —— 主进程再算一遍等于把"一份实现"变成两份。
 *
 * @param ipcMain Electron 的 ipcMain
 */
export function registerSessionIpc(ipcMain: Electron.IpcMain): void {
  ipcMain.handle(SESSION_CHANNEL.list, () => listChatSessions());
  ipcMain.handle(SESSION_CHANNEL.load, async (_event, sessionId: unknown) => {
    const got = await readSessionLog(sessionId);
    return got;
  });
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
