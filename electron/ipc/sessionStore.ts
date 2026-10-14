import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

import { parseLog, type LogInput } from "../../engine/core/events";
import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import type { SessionStore } from "../../engine/ports/store";

/*
 * ⚠️ `SessionSummary` **定义在契约里**（`shared/ipc.ts`）—— 这里只转发。
 *
 * 原来这一份是**重复声明**：同一个形状两处各写一遍，改一处不会报错，
 * 只会表现为"主进程回的东西渲染层认不出"。C4 的口径是**契约只有一份**。
 */
import type { SessionSummary } from "../../shared/ipc";
export type { SessionSummary };

/**
 * 桌面的会话存储与它的读接口（Phase 4.3：**换成了 SQLite**）。
 *
 * ## 换代前后变了什么（这一段是这次改动的核心，别跳过）
 *
 * | | 换代前 | 现在 |
 * |---|---|---|
 * | 落盘 | 一段会话一个 `.jsonl`，主进程自己追加 | `userData/sessions.db`（`node:sqlite`），由**内核**经 store 端口写 |
 * | 读 | 整文件读进来 + 逐行 parse | 带索引的查询（`WHERE session_id = ? ORDER BY seq`） |
 * | 写 | 主进程两处各抓一个写入器（`ai:chat` 与 `ai:runTool`），靠"进程内共用"避免 seq 撞号 | 一个 store，编号在它内部串行分配 |
 * | 事务 | 无（写第 2 条时崩，第 1 条已落下去） | 一次 `append` 整批一个事务 |
 * | 保留 | 按天删文件 / 按条数删文件 / 单文件超 4MB **轮转**（会话被截成两半） | 按天、按条数、按容量，**整会话淘汰**（见 `engine/adapters/sqliteStore.ts`） |
 * | 旧数据 | —— | 启动时**一次性搬进库**（只读旧、写新、不删旧，幂等） |
 *
 * ## 为什么读接口要 `await ready`
 *
 * 迁移与收口是"首屏之前必须完成的事"：不等的话，老用户升级上来的**第一眼是空列表**
 * （"我的对话都没了"），几百毫秒后它又自己冒出来。那种闪一下比慢一点难解释得多。
 *
 * ## ⚠️ 安全：会话 id 是**渲染进程给的**
 *
 * 它进 SQL（参数化，不会注入）也进磁盘路径（迁移时读旧文件），所以**仍然**要收窄成
 * `[A-Za-z0-9._-]`（并拒掉以 `.` 开头的）—— 否则 `../../` 这种 id 能让旧日志的读取
 * 跑到 userData 之外（`safeSessionId`）。收不窄就当成"没给"，不报错、不影响对话。
 */

/** 旧的 `.jsonl` 日志目录（**只读**：迁移完留在原地，见 `migrateLegacyJsonl`）。 */
function sessionsDir(): string {
  return path.join(app.getPath("userData"), "sessions");
}

/**
 * 会话 id 收窄。
 *
 * @param raw 渲染进程给的 id（不可信）
 * @returns 可安全当路径用的 id；不合法返回 null
 */
export function safeSessionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(id)) return null;
  // `..` 由上面的正则已经排掉（不含连续点也不以点开头），这里只是把意图写明白
  if (id.includes("..")) return null;
  return id;
}

/** IPC 通道名（preload 与主进程共用）。 */
export const SESSION_CHANNEL = {
  /** 列聊天会话（F3：重启后把对话列表恢复出来）。 */
  list: "session:list",
  /** 读回一整段会话的记录（渲染层自己投影成消息）。 */
  load: "session:load",
} as const;

/* ────────────────────── 桌面会话库 ────────────────────── */

let desktopStore: SessionStore | null = null;

/**
 * 桌面的会话存储：**SQLite**（`userData/sessions.db`）。
 *
 * ⚠️ **惰性**创建，不能在模块加载时就建 —— 主进程的 `configureDataDir()` 会
 * `app.setPath("userData", …)`（`DSH_CANVAS_DATA_DIR` 覆盖、开发态指向工程根的 `data/`），
 * 而 ESM 的 import 全部在 `main.ts` 的顶层语句**之前**求值。
 * 模块加载时就建库的话，库会落到**默认** userData 里 —— 而应用其余数据在新目录，
 * 表现是"日志在另一个地方"，那种错要翻很久。
 */
export function desktopSessionStore(): SessionStore {
  if (!desktopStore) {
    desktopStore = createSqliteSessionStore(app.getPath("userData"), "sessions.db");
  }
  return desktopStore;
}

/** 首屏之前必须完成的事（迁移 + 收口），只做一次。 */
let readyPromise: Promise<void> | null = null;

function ready(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      const store = desktopSessionStore();
      const migrated = await migrateLegacyJsonl(store);
      if (migrated.files) {
        const bad = migrated.skipped ? `，跳过 ${migrated.skipped} 条坏行` : "";
        console.log(`[session] 已从旧 jsonl 迁移 ${migrated.files} 个会话（${migrated.records} 条记录${bad}）`);
      }
      const { deleted } = await store.prune();
      if (deleted.length) console.log(`[session] 收口时淘汰了 ${deleted.length} 个过期会话`);
    })().catch((error) => {
      // 迁移失败不该拦住应用起来；下次启动会再试（迁移是幂等的）
      console.error("[session] 迁移/收口失败（下次启动重试）：", error instanceof Error ? error.message : error);
    });
  }
  return readyPromise;
}

/**
 * 把旧的 `.jsonl` 会话日志一次性搬进 SQLite。
 *
 * ## 三条边界
 *
 * - **只读旧、写新、不删旧**：迁到一半崩掉时，损失上限只是"重跑一次"。
 *   旧文件留在 `userData/sessions/` 里，用户自己也翻得到（也是排查现场的原料）。
 * - **幂等**：库里已经有那个会话就跳过 —— 所以它可以每次启动都跑，跑不坏。
 * - **坏行只跳过它自己**（与 `parseLog` 同一个口径），并计入 `skipped` 报出来。
 *
 * @param store 目标库
 * @returns 迁了几个文件、几条记录、几个坏行
 */
async function migrateLegacyJsonl(store: SessionStore): Promise<{ files: number; records: number; skipped: number }> {
  let names: string[] = [];
  try {
    names = (await readdir(sessionsDir())).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return { files: 0, records: 0, skipped: 0 }; // 目录还没建过 = 没有旧数据
  }
  if (!names.length) return { files: 0, records: 0, skipped: 0 };

  // 库里已有的会话（迁移幂等的关键：重跑不会把老会话再灌一遍）
  const existing = new Set((await store.list()).map((x) => x.sessionId));

  let files = 0;
  let records = 0;
  let skipped = 0;
  for (const name of names) {
    const sessionId = name.slice(0, -".jsonl".length);
    if (!safeSessionId(sessionId) || existing.has(sessionId)) continue;
    let text = "";
    try {
      text = await readFile(path.join(sessionsDir(), name), "utf8");
    } catch {
      continue; // 读不了就跳过（下次启动再试）
    }
    const parsed = parseLog(text);
    skipped += parsed.skipped;
    if (!parsed.records.length) continue;
    /*
     * 旧编号只用来排序：新库的编号由 store 自己发 ——
     * 让外部决定编号正是"两个写入器撞号"的来源（换代前实测过那个毛病）。
     */
    const ordered = [...parsed.records]
      .sort((a, b) => a.seq - b.seq)
      .map(({ seq: _seq, at: _at, ...rest }) => rest);
    await store.append(sessionId, ordered as LogInput[]);
    files += 1;
    records += ordered.length;
  }
  return { files, records, skipped };
}

/**
 * 注册会话日志 IPC（F3）。
 *
 * ⚠️ 只回**记录**，不回"投影好的消息"：投影是纯函数（`engine/core/events.ts`），
 * 渲染层自己调就行 —— 主进程再算一遍等于把"一份实现"变成两份。
 *
 * @param ipcMain Electron 的 ipcMain
 */
export function registerSessionIpc(ipcMain: Electron.IpcMain): void {
  ipcMain.handle(SESSION_CHANNEL.list, async (_event, kind: unknown) => {
    await ready();
    // 不给 = 只列聊天（渲染层的既有行为）；`all` = 全都列（验收脚本要看 task- 的）
    if (kind === "all" || kind === undefined) {
      return kind === "all" ? desktopSessionStore().list() : desktopSessionStore().list({ kind: "chat" });
    }
    if (kind === "chat" || kind === "task" || kind === "cli") return desktopSessionStore().list({ kind });
    return desktopSessionStore().list({ kind: "chat" });
  });
  ipcMain.handle(SESSION_CHANNEL.load, async (_event, sessionId: unknown) => {
    await ready();
    const id = safeSessionId(sessionId);
    if (!id) return { records: [], skipped: 0 };
    return desktopSessionStore().load(id);
  });
}
