import type { SqliteDatabase } from "./sqliteDriver";

/**
 * 会话库的**检索那一套**：正文列（审计 P136）、FTS5 能力与索引迁移（P140 / P101）、
 * 以及摘要截取。
 *
 * ## 为什么从 `sqliteStore.ts` 拆出来（2026-10-16）
 *
 * `sqliteStore.ts` 在做 P14/P31/P32 那一轮时顶破了"巨石文件"守卫
 * （`src/structureGuard.test.ts`：`.ts` ≤ 900 行）。拆的依据是**它自己本来就是一整块**：
 *
 *   · 正文怎么拼（`searchBodyOf` —— 给检索用的那一列，与"落盘形态"是两件事）；
 *   · 库里的索引能不能用 FTS（`fts5Available`）以及**老库怎么把索引搬过来**
 *     （`prepareSearchIndex`：补列 → 回填 → 重建，顺序有意义）；
 *   · 命中了怎么摘一小段给用户看（`excerptOf`）。
 *
 * 这三件事都不碰"会话/事件怎么写进去"（那才是 store 的事），
 * 所以边界不靠"行数够了"，靠"它只认一个 `SqliteDatabase` 和一张正文表"。
 *
 * ## 版本号为什么是参数
 *
 * `PRAGMA user_version` 由**库的持有者**决定（`sqliteStore.ts` 的 `SCHEMA_VERSION`）：
 * 版本说的是"这张表结构是哪一版"，不是"检索那一套是哪一版"，所以它不搬过来。
 *
 * @param db 打开好的库
 * @param schemaVersion 迁移完之后要写上的表结构版本
 * @returns 这台机器上的检索能不能走 FTS（false = 调用方降级到 LIKE）
 */
/**
 * 全文索引（Phase 12.4；审计 P136 把索引的列从 `payload` 改成 `body`）。
 *
 * 为什么用 FTS5、为什么要 external-content、中文为什么不按词搜 —— 见 `search()` 那段说明
 * （同一个理由不在两处各写一遍）。
 *
 * ⚠️ external-content 的代价有两条，都得自己收拾：**增删同步**（下面三条触发器）
 * 与**既有行不会自动进索引**（要 `'rebuild'`，见 `prepareSearchIndex`）。
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(body, content='events', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO events_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`;

/** 撤掉全文索引那一套（触发器先走：表被删掉之后它们会变成会报错的孤儿）。 */
const FTS_DROP = `
DROP TRIGGER IF EXISTS events_fts_ai;
DROP TRIGGER IF EXISTS events_fts_ad;
DROP TRIGGER IF EXISTS events_fts_au;
DROP TABLE IF EXISTS events_fts;
`;

/** 只撤触发器（没有 FTS5 时用：虚拟表可能连 DROP 都打不开）。 */
const FTS_TRIGGERS_DROP = `
DROP TRIGGER IF EXISTS events_fts_ai;
DROP TRIGGER IF EXISTS events_fts_ad;
DROP TRIGGER IF EXISTS events_fts_au;
`;

/** 让 FTS5 按 `events` 当前内容**重建**整个索引（external-content 表的唯一回填手段）。 */
const FTS_REBUILD = "INSERT INTO events_fts(events_fts) VALUES('rebuild')";

/** 现存 FTS 表是不是"按正文索引"那一版（认不出来就重建）。 */
const FTS_BODY_MARK = /fts5\s*\(\s*body\b/i;

/**
 * 把值里的**字符串叶子**收进数组（**不含字段名**）。
 *
 * ⚠️ 只收值、不收键是刻意的（审计 P136）：工具参数 `{"path":"a.md"}` 里
 * `path` 是**契约的一部分**，不是"用户说过的话"；把它也当正文，搜 `path`
 * 就会命中一大片。深度封顶是防病态嵌套，不是性能优化。
 */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out, depth + 1);
  }
}

/**
 * 一条记录**该被搜到的正文**（写的时候算好，存进 `events.body`）。
 *
 * ## 为什么要有这个函数（审计 P136）
 *
 * 原来检索把**整行 JSON**（`JSON.stringify({seq,at,...record})`）当正文匹配，
 * 于是搜 `request`、`text`、`seq`、`provider`、`按需确认`、`strata` 这类
 * 出现在**字段名或策略值**里的词会假命中；摘要也会摘出一段 JSON 噪声
 * （"为什么这条被搜出来"答非所问）。
 *
 * ## 取哪些
 *
 * - `request`：**只有消息正文** —— 用户说过的话在这里。provider / model /
 *   toolPolicy / tools / system 都是元数据（搜 `deepseek` 不该把整段会话捞出来）。
 * - 其余事件：正文、错误、工具名与**工具参数/结果里的字符串**、委派的任务与结论、
 *   决策记录那一行。都是"用户看得见的内容"。
 *
 * @param record 一条记录（含 `seq`/`at` 也没关系：它们不在取值名单里）
 * @returns 拼好的正文（可能是空串 —— 那就搜不到它，这是对的）
 */
export function searchBodyOf(record: Record<string, unknown>): string {
  const out: string[] = [];
  if (record.type === "request") {
    const messages = Array.isArray(record.messages) ? record.messages : [];
    for (const message of messages) {
      const content = (message as { content?: unknown } | null | undefined)?.content;
      if (typeof content === "string") {
        if (content.trim()) out.push(content);
      } else {
        collectStrings(content, out);
      }
    }
    return out.join("\n");
  }
  collectStrings(record.text, out);
  collectStrings(record.message, out); // error 那一句
  collectStrings(record.toolName, out);
  collectStrings(record.name, out);
  collectStrings(record.line, out); // approval 那一行（用户看得见）
  collectStrings(record.agent, out); // delegation
  collectStrings(record.task, out);
  collectStrings(record.summary, out);
  collectStrings(record.error, out);
  collectStrings(record.input, out); // 工具参数（只取字符串叶子）
  collectStrings(record.output, out); // 工具结果（含工具留痕里的正文）
  return out.join("\n");
}

/** 一次性的 `all` 查询：**用完就释放**（审计 P144 的口径：别只 prepare 不释放）。 */
function queryAll(db: SqliteDatabase, sql: string, ...params: unknown[]): unknown[] {
  const statement = db.prepare(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize?.();
  }
}

/** 一次性的 `get` 查询（同上）。 */
function queryGet(db: SqliteDatabase, sql: string, ...params: unknown[]): unknown {
  const statement = db.prepare(sql);
  try {
    return statement.get(...params);
  } finally {
    statement.finalize?.();
  }
}

/** 建表之后、用之前要做的迁移与探测（P101 回填 / P136 列 / P140 降级）。 */
function tableSql(db: SqliteDatabase, name: string): string | null {
  const row = queryGet(db, "SELECT sql FROM sqlite_master WHERE name = ?", name) as
    | { sql?: string | null }
    | undefined;
  return typeof row?.sql === "string" ? row.sql : null;
}

/** 老库（12.4 之前）没有 `body` 列：补上。@returns 这次是不是真加了 */
function ensureBodyColumn(db: SqliteDatabase): boolean {
  const cols = queryAll(db, "PRAGMA table_info(events)") as { name?: string }[];
  if (cols.some((c) => c.name === "body")) return false;
  db.exec("ALTER TABLE events ADD COLUMN body TEXT NOT NULL DEFAULT ''");
  return true;
}

/** 当前库的 schema 版本（`PRAGMA user_version` 是本库私有的）。 */
function userVersion(db: SqliteDatabase): number {
  const row = queryGet(db, "PRAGMA user_version") as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * 这个 SQLite 构建**有没有 FTS5**（审计 P140）。
 *
 * 用 `temp.` 里的一次探测，而不是"看 `CREATE VIRTUAL TABLE` 成不成功"：
 * 探针表建在 temp schema 里，失败也不会在库里留下半张表。
 */
function fts5Available(db: SqliteDatabase): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x)");
    db.exec("DROP TABLE temp.__fts_probe");
    return true;
  } catch {
    return false;
  }
}

/** 老库的 `body` 空白行回填（**只补空串**，反复跑无副作用）。@returns 回填了几行 */
function backfillBodies(db: SqliteDatabase): number {
  const rows = queryAll(db, "SELECT rowid AS rid, payload FROM events WHERE body = ''") as {
    rid: number | bigint;
    payload: string;
  }[];
  if (!rows.length) return 0;
  const update = db.prepare("UPDATE events SET body = ? WHERE rowid = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      let record: Record<string, unknown> | null = null;
      try {
        record = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        record = null; // 坏行：正文留空（它本来就解析不出来）
      }
      update.run(record ? searchBodyOf(record) : "", row.rid);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  update.finalize?.(); // 局部语句用完就放（Bun 有 finalize，node:sqlite 靠 GC）
  return rows.length;
}

/**
 * 把"检索那一套"准备好，并如实返回**能不能走 FTS**。
 *
 * 三件事，顺序有意义（审计 P101 · P136 · P140）：
 *   ① 老库补 `body` 列并**回填**（不补的话那些行在新索引里永远不存在 ——
 *      external-content 表不会自动索引既有行）；
 *   ② 探测 FTS5 能力：**没有就降级**（撤掉触发器、只走 LIKE），
 *      而不是让整个会话库打不开；
 *   ③ 现存索引若不是"按正文索引"那一版（老库是 `fts5(payload)`，或索引丢了），
 *      重建 + `'rebuild'` 回填 —— 版本迁移与"索引被删掉"两种情况一起兜住。
 */
export function prepareSearchIndex(db: SqliteDatabase, schemaVersion: number): boolean {
  const addedBody = ensureBodyColumn(db);
  if (addedBody || userVersion(db) < schemaVersion) {
    backfillBodies(db);
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
  }

  if (!fts5Available(db)) {
    /*
     * 没有 FTS5：触发器必须撤掉。留着它们的话，每次 append 都要去写那张表 ——
     * 轻则写进一张没人读的表（索引永远不同步），重则直接报 "no such module: fts5"。
     * ⚠️ 虚拟表**不**在这里 DROP：模块都不在，DROP 可能自己就报错。
     */
    try {
      db.exec(FTS_TRIGGERS_DROP);
    } catch {
      /* 触发器都不存在时也算成功 */
    }
    return false;
  }

  const existing = tableSql(db, "events_fts");
  if (!existing || !FTS_BODY_MARK.test(existing)) {
    db.exec(FTS_DROP);
    db.exec(FTS_SCHEMA);
    db.exec(FTS_REBUILD);
  }
  return true;
}

/**
 * 从一段**正文**里摘一小段命中上下文（前后各留一点）。
 *
 * ⚠️ 摘的是**原文**，不生成任何字 —— 生成的东西没法保证与原文一致，
 * 而用户点开之前就是靠这一小段判断这条是不是我要找的。
 *
 * ⚠️ 参数是 `events.body`（`searchBodyOf` 算好的正文），不是整行 JSON
 * （审计 P136：原来摘到的是 `{"seq":3,"requestId":…}` 这种噪声，"答非所问的摘要"）。
 */
export function excerptOf(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, 120);
  const from = Math.max(0, at - 40);
  const to = Math.min(text.length, at + query.length + 60);
  return (from > 0 ? "…" : "") + text.slice(from, to) + (to < text.length ? "…" : "");
}
