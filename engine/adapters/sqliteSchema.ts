import type { SqliteDatabase } from "./sqliteDriver";
import { adoptSearchBody } from "./sqliteSearch";

/**
 * 会话库的**版本化迁移链**（V5-1 任务 3.3a；ADR-005）。
 *
 * ## 它解决什么
 *
 * 之前这个库只有一条 `PRAGMA user_version` 判据：`prepareSearchIndex` 里
 * "版本落后就补列 + 回填 + 写版本号"——**有版本、没有链**。再加一步迁移时，
 * 那个 `if` 会长成 `if v < 3 … if v < 4 …` 的意大利面，而且没有任何地方能回答
 * "这个库经历过哪些版本、什么时候"。
 *
 * 现在：**有序的迁移表 + 一本可查的账**。
 *
 * · `MIGRATIONS`：只增不改（每一步要么建表要么补列/回填，**不删不重命名**）；
 * · `schema_version(version, name, applied_at)`：每应用一步写一行（PRIMARY KEY 兜住重跑）；
 * · **不可降级**：库的版本高于本程序 → 抛 `SchemaDowngradeError`，拒绝读写
 *   （"老程序打开新库"会把新结构的数据按老口径解释，那是静默损坏）；
 * · 老库**认领**：迁移表上线之前建的库，按 `PRAGMA user_version` + 表在不在
 *   反推出它已经走到哪一版，补记账（`adopted`，如实标出"这不是这次跑的"）。
 *
 * ## 与历史迁移的分工（3.3b）
 *
 * 本仓有**两代迁移**，各管一层，别混：
 *
 * | 谁 | 管什么 | 形态 |
 * |---|---|---|
 * | `migrateLegacyJsonl*`（Phase 12 / 4.3） | **存储格式换代**：旧 `.jsonl` 文件 → 库 | 读旧写新不删旧，幂等，宿主侧调 |
 * | 本模块 | **库内的表结构演进**：加列/加表/回填 | 有序、版本记账、不可降级 |
 *
 * 顺序固定：先换代（数据进库）、再演进（库内升版）—— 库一旦建出来，
 * `createSqliteSessionStore` 打开时就跑链，之后宿主再做 jsonl 迁移（不会互相踩：
 * 迁移只 `append`，链只碰结构）。
 *
 * ## 迁移失败的边界
 *
 * 每一步在自己的事务里（`BEGIN IMMEDIATE`）；失败 → `ROLLBACK` + 抛错
 * （**不吞**：库停在旧版本、旧路径照旧可用，这正是"留旧路径"的用法）。
 * 本模块**不负责**备份 —— 那需要知道库文件路径，由宿主在跑链之前做
 * （`sqliteStore.ts` 里：有 pending 就先把库文件复制一份 `.pre-migrate.bak`）。
 */

/** 会话库的**表结构版本**（最后一步迁移的版本号）。 */
export const SCHEMA_VERSION = 4;

/** 一步迁移。 */
export type MigrationStep = {
  /** 版本号（**连续**：1、2、3…；中间不许跳号，守卫在测试里）。 */
  version: number;
  /** 人话名字（写进 `schema_version.name`，读账的人不用回头翻代码）。 */
  name: string;
  /** 干活的（跑在事务里；要么改完，要么回滚）。 */
  apply: (db: SqliteDatabase) => void;
};

/**
 * 基线表结构（幂等）。
 *
 * ⚠️ **FTS5 那一套刻意不在这里**（审计 P140）：`CREATE VIRTUAL TABLE ... USING fts5`
 * 一放进这条串里，任何没编 FTS5 的 SQLite 构建上 `db.exec(SCHEMA)` 就直接抛 ——
 * 会话库**整个打不开**，而不是"检索退化"。现在它在 `sqliteSearch.ts` 的 `FTS_SCHEMA` 里，
 * 由 `prepareSearchIndex` 先探测能力再决定建不建。
 */
const BASELINE = `
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
  body       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
`;

/**
 * 迁移表（**只许往后加**）。
 *
 * 规矩（ADR-005）：新的一步只做"加"（新表 / 新列 + 回填）；删列改名要走
 * "先加新的、双写一段、再移除"的三步，而且必须带着 ADR。
 */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    name: "基线（sessions / events 两表 + 索引）",
    apply: (db) => db.exec(BASELINE),
  },
  {
    version: 2,
    name: "正文列与回填（审计 P101 / P136）",
    apply: (db) => {
      adoptSearchBody(db);
    },
  },
  {
    version: 3,
    name: "事件 actor 维度（C5）",
    apply: (db) => {
      /*
       * 两列默认 `'legacy'`：**v3 之前的行不可能带 actor**（actor 与这两列同一笔
       * 提交上线，见 ADR-006），所以"补列"本身就是完整的迁移 —— 不需要从 payload 搬值。
       * 读回时 payload 说了算（`parseLogLine` 给老记录填 `LEGACY_ACTOR`），
       * 这两列是给**查询/审计**用的（"某人做过什么"不该把每行 JSON 解一遍）。
       */
      const cols = queryAll(db, "PRAGMA table_info(events)") as { name?: string }[];
      if (!cols.some((c) => c.name === "actor_id")) {
        db.exec("ALTER TABLE events ADD COLUMN actor_id TEXT NOT NULL DEFAULT 'legacy'");
      }
      if (!cols.some((c) => c.name === "actor_kind")) {
        db.exec("ALTER TABLE events ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'legacy'");
      }
    },
  },
  {
    version: 4,
    name: "会话归属（C1）",
    apply: (db) => {
      /*
       * `owner` 默认 `'local'`：V5 §3.1 兼容矩阵的明文口径（"旧会话零迁移可读"）。
       * 补列即完整迁移：老会话没有归属这个事实，默认成本机用户 —— **不编别的**。
       * V5-2/3 的成员模型接上来之后，新会话会写真实成员 id（见 `AppendOptions.owner`）。
       */
      const cols = queryAll(db, "PRAGMA table_info(sessions)") as { name?: string }[];
      if (!cols.some((c) => c.name === "owner")) {
        db.exec("ALTER TABLE sessions ADD COLUMN owner TEXT NOT NULL DEFAULT 'local'");
      }
    },
  },
];

/**
 * 账本表（框架自己管，不算一步迁移 —— 它必须**先于**读版本存在）。
 *
 * ⚠️ 比草案（V5 §3.2b 的 `schema_version(version, applied_at)`）多一列 `name`：
 * 读账的人不该为了知道"v2 是什么"去翻代码；PRIMARY KEY 让重跑天然幂等。
 */
const LEDGER = `
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

/** 库的版本高于本程序：拒绝读写（见文件头的"不可降级"）。 */
export class SchemaDowngradeError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `这个会话库是更新版本的程序建的（库 v${found}，本程序支持到 v${supported}）：` +
        `拒绝按旧口径读写它。请用新版本的程序打开；若确实要降级，先备份并删除/改名这个库。`,
    );
    this.name = "SchemaDowngradeError";
  }
}

/** 一次迁移的结果（宿主拿它写日志 / 决定要不要提示备份路径）。 */
export type MigrationReport = {
  /** 跑之前账上到哪一版（认领之后算）。 */
  from: number;
  /** 跑之后。 */
  to: number;
  /** 这次真的跑的版本号（升序）。 */
  applied: number[];
  /** 认领的版本号（迁移表上线之前就已应用 —— 这次**没有**跑它们）。 */
  adopted: number[];
};

/** 一次性查询（用完释放；审计 P144 的口径）。 */
function queryGet(db: SqliteDatabase, sql: string, ...params: unknown[]): unknown {
  const statement = db.prepare(sql);
  try {
    return statement.get(...params);
  } finally {
    statement.finalize?.();
  }
}

function queryAll(db: SqliteDatabase, sql: string, ...params: unknown[]): unknown[] {
  const statement = db.prepare(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize?.();
  }
}

/** 一次性写（P144 同口径：**用完就放**，别只 prepare 不释放）。 */
function runOnce(db: SqliteDatabase, sql: string, ...params: unknown[]): void {
  const statement = db.prepare(sql);
  try {
    statement.run(...params);
  } finally {
    statement.finalize?.();
  }
}

/** 表在不在（`sqlite_master` 是权威）。 */
function hasTable(db: SqliteDatabase, name: string): boolean {
  return Boolean(queryGet(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name));
}

/** `PRAGMA user_version`（迁移表上线之前的唯一版本记录）。 */
function userVersion(db: SqliteDatabase): number {
  const row = queryGet(db, "PRAGMA user_version") as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** 账上记了的版本（表不在就是空）。 */
function ledgerVersions(db: SqliteDatabase): number[] {
  if (!hasTable(db, "schema_version")) return [];
  return (queryAll(db, "SELECT version FROM schema_version ORDER BY version") as { version?: number | bigint }[]).map((r) =>
    Number(r.version ?? 0),
  );
}

/**
 * 这个库现在算哪一版（三条线索取最大）。
 *
 * 三条都要看，各有各的来历：
 *   · 账本（本框架记的）；
 *   · `PRAGMA user_version`（框架上线前那套写的；**降级保护也靠它**——
 *     老程序不认账本表，但它会写这个）；
 *   · 表在不在（最老的库：两表建出来了，但那时还没有任何版本记录 → 至少是 v1）。
 */
function currentVersion(db: SqliteDatabase): number {
  const ledger = ledgerVersions(db);
  const fromLedger = ledger.length ? ledger[ledger.length - 1]! : 0;
  const baseline = hasTable(db, "events") || hasTable(db, "sessions") ? 1 : 0;
  return Math.max(fromLedger, userVersion(db), baseline);
}

/**
 * 还没应用的迁移（升序）。
 *
 * ⚠️ **不写库**（宿主拿它决定"要不要先备份库文件"）。
 */
export function pendingMigrations(db: SqliteDatabase): MigrationStep[] {
  const at = currentVersion(db);
  return MIGRATIONS.filter((m) => m.version > at);
}

/**
 * 跑迁移链。
 *
 * @param db 打开好的库
 * @param now 记账用的时间（测试传固定值；缺省取真实时间）
 * @param steps 链本身（**只有测试会传**：构造"某一步炸了"的回滚场景）
 * @returns 这次做了什么（`applied` / `adopted` / from / to）
 * @throws {SchemaDowngradeError} 库比本程序新
 */
export function runMigrations(
  db: SqliteDatabase,
  now: number = Date.now(),
  steps: readonly MigrationStep[] = MIGRATIONS,
): MigrationReport {
  const ledgerExisted = hasTable(db, "schema_version");
  db.exec(LEDGER);

  /* 降级闸门认的是**常量**（`steps` 只多不少时也要拦住"库比程序新"） */
  const known = currentVersion(db);
  if (known > SCHEMA_VERSION) throw new SchemaDowngradeError(known, SCHEMA_VERSION);

  /*
   * 认领：老库在账本上线之前就已应用到的版本 —— 补记账，但**如实标出**它不是这次跑的。
   * 只在"账本本来就是空的"时候认领：一旦有了账本，版本从账上读，不再反推。
   */
  const adopted: number[] = [];
  if (!ledgerExisted && ledgerVersions(db).length === 0) {
    for (const step of steps) {
      if (step.version > known) break;
      runOnce(
        db,
        "INSERT OR IGNORE INTO schema_version(version, name, applied_at) VALUES(?, ?, ?)",
        step.version,
        step.name,
        new Date(now).toISOString(),
      );
      adopted.push(step.version);
    }
    /* 老库没有 user_version 时（最老那一代）补上，免得下一版又"反推"一次 */
    if (userVersion(db) < known) db.exec(`PRAGMA user_version = ${known}`);
  }

  const from = currentVersion(db);
  const applied: number[] = [];
  for (const step of steps.filter((m) => m.version > from)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      step.apply(db);
      runOnce(
        db,
        "INSERT OR REPLACE INTO schema_version(version, name, applied_at) VALUES(?, ?, ?)",
        step.version,
        step.name,
        new Date(now).toISOString(),
      );
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 事务可能已经自己结束（例如 DDL 失败），回滚失败不掩盖真正的错误 */
      }
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`会话库迁移 v${step.version}（${step.name}）失败：${why} —— 库停在 v${from}，旧数据未动。`);
    }
    applied.push(step.version);
  }

  return { from, to: currentVersion(db), applied, adopted };
}

/**
 * 读账（诊断/验收用）：每行是 `{version, name, appliedAt}`，按版本升序。
 *
 * 表不在 = 这个库还没跑过链（空数组，不是报错）。
 */
export function schemaLedger(db: SqliteDatabase): { version: number; name: string; appliedAt: string }[] {
  if (!hasTable(db, "schema_version")) return [];
  return (
    queryAll(db, "SELECT version, name, applied_at FROM schema_version ORDER BY version") as {
      version?: number | bigint;
      name?: string;
      applied_at?: string;
    }[]
  ).map((r) => ({ version: Number(r.version ?? 0), name: String(r.name ?? ""), appliedAt: String(r.applied_at ?? "") }));
}
