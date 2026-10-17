import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { openSqlite, type SqliteDatabase } from "../adapters/sqliteDriver";
import { chunkText } from "./chunk";

/**
 * 本地知识库（V6-3e）。
 *
 * ## 为什么默认不是向量库
 *
 * 50 页文档在本地用 **FTS5 + LIKE 混合**已经够快（`≤2s` 的性能预算里这是毫秒级），
 * 而且零模型调用、零额外依赖。向量检索要 embedding（钱 + 网络 + 模型版本漂移），
 * 在"本地优先"的产品里应该是**可选项**，不是默认。
 *
 * 什么时候该换：文档上千页、或需要语义近似（"报销流程"命中"费用审批步骤"）。
 * 那时再上向量库，索引格式与引用结构都不用变 —— 换的是 recall 实现。
 *
 * ## 引用必须可溯源
 *
 * 每条命中带 `citation`（标题 + 路径 + 第几段）。模型引用它、用户能点开原文核对 ——
 * "答得像"不算数，"能在原文找到"才算。
 *
 * ## 权限
 *
 * `private` 只有 `owner` 能搜到；`team` 所有人可见。**过滤发生在检索层**，
 * 不是"搜出来再在界面上藏"—— 后者会把别人的私有内容送到模型上下文里。
 */

export type KnowledgeDomain = "private" | "team";

export type KnowledgeDoc = {
  id: string;
  path: string;
  title: string;
  domain: KnowledgeDomain;
  owner: string;
  sha: string;
  bytes: number;
  addedAt: number;
  chunks: number;
};

export type KnowledgeHit = {
  docId: string;
  path: string;
  title: string;
  domain: KnowledgeDomain;
  owner: string;
  /** 0 基段号。 */
  ordinal: number;
  text: string;
  score: number;
  /** 给人/模型看的引用（标题 + 路径 + 第几段）。 */
  citation: string;
};

export type AddDocumentInput = {
  path: string;
  title?: string;
  text: string;
  domain?: KnowledgeDomain;
  owner?: string;
};

export type KnowledgeStore = {
  addDocument(input: AddDocumentInput): { doc: KnowledgeDoc; replaced: boolean };
  removeDocument(idOrPath: string): { removed: number };
  list(viewer: string): KnowledgeDoc[];
  search(query: string, opts?: { viewer?: string; limit?: number }): KnowledgeHit[];
  close(): void;
  /** 库文件（给人看"数据在哪"）。 */
  file: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS k_docs (
  id       TEXT PRIMARY KEY,
  path     TEXT NOT NULL,
  title    TEXT NOT NULL,
  domain   TEXT NOT NULL,
  owner    TEXT NOT NULL,
  sha      TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS k_docs_path ON k_docs(path);
CREATE TABLE IF NOT EXISTS k_chunks (
  doc_id  TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text    TEXT NOT NULL,
  PRIMARY KEY (doc_id, ordinal)
);
CREATE INDEX IF NOT EXISTS k_chunks_doc ON k_chunks(doc_id);
`;

/** 文档 id：内容 + 路径的哈希（同内容不同路径是不同文档；重灌同一份不重复）。 */
function docIdOf(filePath: string, text: string): string {
  return createHash("sha256").update(`${filePath}\u0000${text}`).digest("hex");
}

/** 可见性：team 全可见；private 只有 owner 可见。 */
function visible(doc: { domain: string; owner: string }, viewer: string): boolean {
  return doc.domain === "team" || doc.owner === viewer;
}

/** FTS 查询串：按词/字块加引号（挡语法注入），CJK 整段作为一个词交给 LIKE 兜底。 */
function ftsQueryOf(query: string): string {
  const terms = (query.match(/[\p{L}\p{N}_-]+/gu) ?? []).map((t) => t.replace(/"/g, "")).filter(Boolean);
  if (!terms.length) return "";
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/** 一条文本里出现了几次关键词（LIKE 兜底的相关度）。 */
function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * 打开知识库（不存在就建）。
 *
 * @param dataDir 数据目录（库文件是 `<dataDir>/knowledge.db`）
 */
export function openKnowledgeStore(dataDir: string): KnowledgeStore {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "knowledge.db");
  const db: SqliteDatabase = openSqlite(file);
  db.exec(SCHEMA);

  /* FTS 尽力而为：这个 SQLite 构建没有 FTS5 时退化成 LIKE（检索仍能用，只是排序粗） */
  let fts = true;
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS k_fts USING fts5(doc_id UNINDEXED, ordinal UNINDEXED, text)");
  } catch {
    fts = false;
  }

  const removeById = (id: string): number => {
    const rows = db.prepare("SELECT COUNT(*) AS n FROM k_chunks WHERE doc_id = ?").get(id) as { n?: number } | undefined;
    db.prepare("DELETE FROM k_chunks WHERE doc_id = ?").run(id);
    if (fts) db.prepare("DELETE FROM k_fts WHERE doc_id = ?").run(id);
    db.prepare("DELETE FROM k_docs WHERE id = ?").run(id);
    return Number(rows?.n ?? 0);
  };

  const docRow = (id: string): KnowledgeDoc | null => {
    const row = db
      .prepare(
        `SELECT d.id, d.path, d.title, d.domain, d.owner, d.sha, d.bytes, d.added_at,
                (SELECT COUNT(*) FROM k_chunks c WHERE c.doc_id = d.id) AS chunks
           FROM k_docs d WHERE d.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      path: String(row.path),
      title: String(row.title),
      domain: String(row.domain) === "team" ? "team" : "private",
      owner: String(row.owner),
      sha: String(row.sha),
      bytes: Number(row.bytes ?? 0),
      addedAt: Number(row.added_at ?? 0),
      chunks: Number(row.chunks ?? 0),
    };
  };

  return {
    file,

    addDocument(input) {
      const text = String(input.text ?? "").replace(/\r\n?/g, "\n").trim();
      if (!text) throw new Error("文档是空的（没有可索引的正文）");
      const filePath = path.resolve(input.path);
      const domain: KnowledgeDomain = input.domain === "team" ? "team" : "private";
      const owner = input.owner?.trim() || "local";
      const chunks = chunkText(text);
      const id = docIdOf(filePath, text);

      /* 同一路径重灌：先把旧的整篇删掉（不然改了文件会留两份引用） */
      const previous = db.prepare("SELECT id FROM k_docs WHERE path = ?").all(filePath) as { id?: string }[];
      for (const row of previous) if (row.id) removeById(row.id);

      db.prepare(
        `INSERT INTO k_docs (id, path, title, domain, owner, sha, bytes, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        filePath,
        input.title?.trim() || path.basename(filePath),
        domain,
        owner,
        createHash("sha256").update(text).digest("hex"),
        Buffer.byteLength(text, "utf8"),
        Date.now(),
      );
      const insert = db.prepare("INSERT INTO k_chunks (doc_id, ordinal, text) VALUES (?, ?, ?)");
      const insertFts = fts ? db.prepare("INSERT INTO k_fts (doc_id, ordinal, text) VALUES (?, ?, ?)") : null;
      for (const chunk of chunks) {
        insert.run(id, chunk.ordinal, chunk.text);
        insertFts?.run(id, chunk.ordinal, chunk.text);
      }
      return { doc: docRow(id)!, replaced: previous.length > 0 };
    },

    removeDocument(idOrPath) {
      const target = String(idOrPath ?? "").trim();
      if (!target) return { removed: 0 };
      const byId = db.prepare("SELECT id FROM k_docs WHERE id = ?").get(target) as { id?: string } | undefined;
      if (byId?.id) return { removed: removeById(byId.id) };
      const byPath = db.prepare("SELECT id FROM k_docs WHERE path = ?").all(path.resolve(target)) as { id?: string }[];
      let removed = 0;
      for (const row of byPath) if (row.id) removed += removeById(row.id);
      return { removed };
    },

    list(viewer) {
      const rows = db
        .prepare(
          `SELECT d.id, d.path, d.title, d.domain, d.owner, d.sha, d.bytes, d.added_at,
                  (SELECT COUNT(*) FROM k_chunks c WHERE c.doc_id = d.id) AS chunks
             FROM k_docs d ORDER BY d.added_at DESC`,
        )
        .all() as Record<string, unknown>[];
      return rows
        .map((row) => ({
          id: String(row.id),
          path: String(row.path),
          title: String(row.title),
          domain: String(row.domain) === "team" ? ("team" as const) : ("private" as const),
          owner: String(row.owner),
          sha: String(row.sha),
          bytes: Number(row.bytes ?? 0),
          addedAt: Number(row.added_at ?? 0),
          chunks: Number(row.chunks ?? 0),
        }))
        .filter((doc) => visible(doc, viewer));
    },

    search(query, opts = {}) {
      const q = String(query ?? "").trim();
      if (!q) return [];
      const viewer = opts.viewer?.trim() || "local";
      const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 8)));
      const found = new Map<string, KnowledgeHit>();

      const consider = (docId: string, ordinal: number, text: string, score: number) => {
        const doc = docRow(docId);
        if (!doc || !visible(doc, viewer)) return;
        const key = `${docId}#${ordinal}`;
        const previous = found.get(key);
        if (previous && previous.score >= score) return;
        found.set(key, {
          docId,
          path: doc.path,
          title: doc.title,
          domain: doc.domain,
          owner: doc.owner,
          ordinal,
          text,
          score,
          citation: `${doc.title}（${doc.path} 第 ${ordinal + 1} 段）`,
        });
      };

      /* ① FTS（英文/分词好的文本排序更准） */
      if (fts) {
        const match = ftsQueryOf(q);
        if (match) {
          try {
            const rows = db
              .prepare(
                `SELECT doc_id, ordinal, text, bm25(k_fts) AS rank FROM k_fts
                  WHERE k_fts MATCH ? ORDER BY rank LIMIT 200`,
              )
              .all(match) as { doc_id?: string; ordinal?: number; text?: string; rank?: number }[];
            for (const row of rows) {
              if (typeof row.doc_id !== "string") continue;
              const rank = Number(row.rank ?? 0);
              consider(row.doc_id, Number(row.ordinal ?? 0), String(row.text ?? ""), 1 / (1 + Math.abs(rank)));
            }
          } catch {
            /* 查询语法被拒（极少见）：让 LIKE 兜底 */
          }
        }
      }

      /* ② LIKE 兜底：CJK 子串与 FTS 分词不到的词都靠它 */
      const tokens = q.split(/\s+/).filter(Boolean);
      const rows = db.prepare("SELECT doc_id, ordinal, text FROM k_chunks").all() as {
        doc_id?: string;
        ordinal?: number;
        text?: string;
      }[];
      for (const row of rows) {
        if (typeof row.doc_id !== "string") continue;
        const text = String(row.text ?? "");
        let hits = 0;
        for (const token of tokens) hits += occurrences(text.toLowerCase(), token.toLowerCase());
        if (!hits) continue;
        consider(row.doc_id, Number(row.ordinal ?? 0), text, hits);
      }

      return [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    },

    close() {
      db.close();
    },
  };
}
