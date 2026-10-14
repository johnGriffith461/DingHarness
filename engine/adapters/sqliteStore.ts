import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  conversationTitle,
  isChatSessionId,
  parseLogLine,
  SESSION_PREFIX,
  type LogInput,
  type LogRecord,
} from "../core/events";
import type { SessionKind, SessionStore } from "../ports/store";
import type { SessionSummary } from "../../shared/ipc";

/**
 * 会话事件的 **SQLite 实现**（Phase 1 D1 的 PoC 结论落地）。
 *
 * ## 为什么是 `node:sqlite` 而不是 better-sqlite3
 *
 * PoC 实测（2026-10-14，本机）：
 *
 * | 候选 | 结果 |
 * |---|---|
 * | `better-sqlite3` | 原生模块 → 需要 MSVC/node-gyp 构建，且 Electron 与 Node 的 ABI 不同，**同一个模块要给两个宿主各编一份**（149 vs 137） |
 * | `node:sqlite` | Node 24 内置；**Electron 44.7 也内置**（实测 `ELECTRON_RUN_AS_NODE=1 electron -p require('node:sqlite')` → OK，其 Node 为 24.21） |
 *
 * 结论：**同一份实现同时服务 CLI 与桌面，零原生构建、零 ABI 重编译**。
 * 这不是"图省事"—— 原生模块那条路会让"新机器上 `pnpm install` 就能跑"变成
 * "先装 Visual Studio 构建工具"，而那正是本项目要避免的那类环境门槛。
 *
 * ⚠️ `node:sqlite` 在 Node 里仍是 experimental（API 稳定但会变）。风险已对冲：
 * 端口（`engine/ports/store.ts`）按意图定死，换回 better-sqlite3 或别的
 * 只需新增一个实现文件，**宿主与内核一行不用改**。
 *
 * ## 表结构
 *
 * ```sql
 * sessions(id, kind, title, updated_at, bytes)   -- 列举用；title 在写入时算好
 * events(session_id, seq, at, type, payload)     -- payload 是**整行 JSON**（与 .jsonl 同形）
 * ```
 *
 * ⚠️ `payload` 存整行 JSON（含 `seq`/`at`）而不是"只存正文"：读回时直接喂给
 * `parseLogLine` —— **校验只有一份**。若拆开存字段，读回路径就会长出第二套校验，
 * 而两套校验迟早对不齐（`parseLogLine` 的规矩：决定一条记录算不算数）。
 */

/** 建表语句（幂等；每次打开都跑一遍，代价可忽略）。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
`;

/** 会话种类 → 前缀。写成表而不是 `if`：加第三种会话时只改这里。 */
const KIND_PREFIX: Record<SessionKind, string> = {
  chat: SESSION_PREFIX.chat,
  task: SESSION_PREFIX.task,
  cli: SESSION_PREFIX.cli,
};

/** 一次写入里 `sessions.bytes` 的增量口径（与 .jsonl 的行字节数同义）。 */
function lineBytes(payload: string): number {
  return Buffer.byteLength(payload, "utf8") + 1;
}

/**
 * 打开（必要时建）一个 SQLite 会话库。
 *
 * @param dir 数据目录（不存在就建）
 * @param file 库文件名（默认 `sessions.db`；测试要并行时各给各的）
 * @returns 满足 `SessionStore` 的实现
 */
export function createSqliteSessionStore(dir: string, file = "sessions.db"): SessionStore {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, file));
  db.exec(SCHEMA);

  const insertEvent = db.prepare(
    "INSERT OR REPLACE INTO events(session_id, seq, at, type, payload) VALUES(?, ?, ?, ?, ?)",
  );
  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?");
  const upsertSession = db.prepare(
    `INSERT INTO sessions(id, kind, title, updated_at, bytes) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = ?, bytes = bytes + ?,
       title = CASE WHEN sessions.title = '' THEN excluded.title ELSE sessions.title END`,
  );
  const selectEvents = db.prepare(
    "SELECT payload FROM events WHERE session_id = ? ORDER BY seq ASC",
  );
  const selectSessions = db.prepare(
    "SELECT id, title, updated_at, bytes FROM sessions ORDER BY updated_at DESC",
  );

  /** 会话种类（按前缀判；`SESSION_PREFIX` 是唯一那份口径）。 */
  function kindOf(sessionId: string): SessionKind {
    if (isChatSessionId(sessionId)) return "chat";
    return sessionId.startsWith(SESSION_PREFIX.cli) ? "cli" : "task";
  }

  return {
    async append(sessionId: string, records: readonly LogInput[]): Promise<LogRecord[]> {
      if (!records.length) return [];
      const kind = kindOf(sessionId);
      const stored: LogRecord[] = [];

      /*
       * ⚠️ 整批一个事务：半批写入会让"请求记录在、它的工具事件不在"这种形状成为可能，
       * 而日志的价值恰恰在顺序与完整。
       */
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = maxSeq.get(sessionId) as { m?: number } | undefined;
        let seq = Number(row?.m ?? 0);
        let bytes = 0;
        let title = "";

        for (const record of records) {
          seq += 1;
          const at = Date.now();
          // 落盘形态与 .jsonl 的一行**同形**（读回时喂同一个 parseLogLine）
          const payload = JSON.stringify({ seq, at, ...record });
          insertEvent.run(sessionId, seq, at, record.type, payload);
          bytes += lineBytes(payload);
          if (!title && record.type === "request") title = conversationTitle([{ seq, at, ...record } as LogRecord]);
          stored.push(JSON.parse(payload) as LogRecord);
        }

        const at = Date.now();
        upsertSession.run(sessionId, kind, title, at, bytes, at, bytes);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      db.exec("COMMIT");
      return stored;
    },

    async load(sessionId: string): Promise<{ records: LogRecord[]; skipped: number }> {
      const rows = selectEvents.all(sessionId) as { payload: string }[];
      const records: LogRecord[] = [];
      let skipped = 0;
      for (const row of rows) {
        // 坏数据只跳过它自己（与 `.jsonl` 那边同一个 parseLogLine）
        const parsed = parseLogLine(row.payload);
        if (parsed) records.push(parsed);
        else skipped += 1;
      }
      records.sort((a, b) => a.seq - b.seq);
      return { records, skipped };
    },

    close(): void {
      db.close();
    },

    async list(opts?: { kind?: SessionKind }): Promise<SessionSummary[]> {
      const rows = selectSessions.all() as { id: string; title: string; updated_at: number; bytes: number }[];
      const out: SessionSummary[] = [];
      for (const row of rows) {
        const kind = kindOf(row.id);
        if (opts?.kind && opts.kind !== kind) continue;
        const prefix = KIND_PREFIX[kind];
        out.push({
          sessionId: row.id,
          conversationId: kind === "chat" ? row.id.slice(prefix.length) : row.id,
          title: row.title,
          updatedAt: Number(row.updated_at),
          bytes: Number(row.bytes),
        });
      }
      return out;
    },
  };
}

/**
 * 把一份 `.jsonl` 会话日志迁进 SQLite（**只读旧、写新，不删旧**）。
 *
 * ## 为什么是"复制"而不是"移动"
 *
 * 迁移最坏的情况是"迁到一半崩了"。只读旧文件的话，那种情况下的损失上限是
 * "重跑一次"，而不是"历史没了"。旧文件留在原处，用户自己也翻得到。
 *
 * @param dir 旧日志所在目录（`.jsonl` 一族）
 * @param store 目标 store
 * @returns 迁了几个文件、几条记录、几个坏行
 */
export async function migrateJsonlSessions(
  dir: string,
  store: SessionStore,
): Promise<{ files: number; records: number; skipped: number }> {
  if (!existsSync(dir)) return { files: 0, records: 0, skipped: 0 };
  let files = 0;
  let records = 0;
  let skipped = 0;

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    const text = readFileSync(path.join(dir, name), "utf8");
    const parsed: LogRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const record = parseLogLine(line);
      if (record) parsed.push(record);
      else skipped += 1;
    }
    if (!parsed.length) continue;
    /*
     * 已经是"落盘形态"（带 seq/at）的那批：整批原样写进去。
     * 旧文件的 seq 与库里的 seq 由 append 自己重新编号 —— 旧编号只用于排序，
     * 保序就够了（新库不让外部决定编号，那是"两个写入器撞号"的来源）。
     */
    const ordered = [...parsed].sort((a, b) => a.seq - b.seq).map(({ seq: _seq, at: _at, ...rest }) => rest);
    await store.append(sessionId, ordered as LogInput[]);
    files += 1;
    records += ordered.length;
  }
  return { files, records, skipped };
}
