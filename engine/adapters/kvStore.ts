import path from "node:path";

import { openSqlite, type SqliteDatabase } from "./sqliteDriver";

/**
 * 配置型数据的 **SQLite KV**（Phase 12.1）。
 *
 * ## 为什么收在这一层
 *
 * 全仓 14 个"配置型 store"（任务 / 记忆 / MCP / 定时 / 日程 / 工作区 / 设置 / 库 …）
 * **都走同一个 `createJsonStore`**（C1 那次收口）。所以"存储 SQLite 化"不需要改 14 处 ——
 * 在这一层换后端，14 个 store 一起换。这也是方案说的"配置型 store → SQLite KV + 信封版本"。
 *
 * ## 三条设计取舍（写在前面，免得下一个人以为写漏了）
 *
 * 1. **键是文件的绝对路径**（Windows 上大小写归一），不是文件名 ——
 *    不同数据目录下同名的 `tasks.json` 不该撞在一起；键也直接告诉你"这份数据原来在哪个文件"。
 * 2. **信封原样保留**：值里存的还是 `{__schema, data}` 那套（`shared/persist` 的 wrap/unwrap），
 *    所以版本迁移链一行都不用改 —— KV 只是换了个存放介质。
 * 3. **一个数据目录一个库**（`stores.db`）：句柄按目录缓存，进程退出时统一关。
 *
 * ## 回退开关
 *
 * `DSH_STORE_BACKEND=file` 就让所有 store 走回 JSON 文件（见 `jsonStore.ts` 的选择逻辑）。
 * 这是方案要求的"迁移只读旧写新不删旧 **+ 回退开关**"里最后那一半：
 * 用户（或我们排查时）能立刻回到旧行为，而旧文件一直在。
 */

/** 库文件名（与 `sessions.db` 并列放在数据目录下）。 */
export const KV_FILE = "stores.db";

type Handle = { db: SqliteDatabase; keyed: Map<string, unknown> };

/** 按数据目录缓存句柄（同一个目录复用同一个连接）。 */
const handles = new Map<string, Handle>();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** 键的归一化：绝对路径 + Windows 大小写不敏感。 */
export function kvKeyFor(file: string): string {
  const abs = path.resolve(file);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function handleFor(dir: string): Handle {
  const key = path.resolve(dir);
  const hit = handles.get(key);
  if (hit) return hit;
  const db = openSqlite(path.join(key, KV_FILE));
  db.exec(SCHEMA);
  const made: Handle = { db, keyed: new Map() };
  handles.set(key, made);
  return made;
}

/**
 * 后端选择：SQLite 还是文件。
 *
 * 判据是环境变量（`file` 走回退），默认 SQLite —— 方案的 12.1 就是"存储全面 SQLite 化"。
 */
export function backendKind(): "sqlite" | "file" {
  return process.env.DSH_STORE_BACKEND?.trim().toLowerCase() === "file" ? "file" : "sqlite";
}

/** 读一条。没有 → `null`（调用方去读旧文件或给兜底值）。 */
export function kvRead(dir: string, file: string): unknown | null {
  const row = handleFor(dir)
    .db.prepare("SELECT value FROM kv WHERE key = ?")
    .get(kvKeyFor(file)) as { value?: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    // 值坏了按"没有"处理：调用方会回落到旧文件/兜底值 —— 不该让一条坏值把界面弄崩
    return null;
  }
}

/** 写一条（同键覆盖）。 */
export function kvWrite(dir: string, file: string, value: unknown): void {
  const handle = handleFor(dir);
  handle.db
    .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(kvKeyFor(file), JSON.stringify(value), Date.now());
}

/** 某个数据目录下已经进了 KV 的全部键（备份/导出用）。 */
export function kvList(dir: string): Array<{ key: string; value: unknown }> {
  const rows = handleFor(dir).db.prepare("SELECT key, value FROM kv ORDER BY key").all() as Array<{
    key: string;
    value: string;
  }>;
  const out: Array<{ key: string; value: unknown }> = [];
  for (const r of rows) {
    try {
      out.push({ key: r.key, value: JSON.parse(r.value) as unknown });
    } catch {
      /* 坏值跳过（导出不该因为一条坏值整体失败） */
    }
  }
  return out;
}

/** 关掉某个目录的句柄（进程退出 / 测试收尾）。 */
export function closeKv(dir?: string): void {
  if (dir) {
    const key = path.resolve(dir);
    const hit = handles.get(key);
    if (hit) {
      try {
        hit.db.close();
      } catch {
        /* 已经关了 */
      }
      handles.delete(key);
    }
    return;
  }
  for (const key of [...handles.keys()]) closeKv(key);
}
