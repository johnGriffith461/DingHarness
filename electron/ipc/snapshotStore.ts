import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { CANVAS_VERSION, migrateCanvasDoc, type CanvasDocument, type CanvasSnapshotFile } from "../../shared/canvas";
/**
 * 快照落盘（PLAN 4.2 / 4.3 / 4.5）。
 *
 * 三条硬约束，对应原版那套机制：
 *   1. **原子写**：先写 `*.tmp` 再 `rename`，避免断电/崩溃留下半截 JSON。
 *   2. **单调 revision + ack**：写盘时标记 `confirmed:false`（未确认），
 *      渲染进程确认后再改成 `true`。启动时若发现未确认快照，说明上次是异常退出。
 *   3. **崩溃恢复**：回退到最后一个已确认的快照，并把"被丢弃的未确认快照"记进
 *      恢复日志，让界面能告诉用户"回退了"。
 *
 * 数据目录用 Electron 的 userData（打包后不会写进安装目录）。
 */

/** 快照目录。 */
export function snapshotDir(): string {
  return path.join(app.getPath("userData"), "canvas");
}

function docPath(): string {
  return path.join(snapshotDir(), "document.json");
}

function ensureDir(): void {
  fs.mkdirSync(snapshotDir(), { recursive: true });
}

/** 原子写：临时文件 + rename。 */
function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
  fs.renameSync(tmp, file);
}

/** 读 JSON，坏文件当作不存在。 */
function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 空文档（首次启动）。 */
export function emptyDocument(): CanvasDocument {
  return {
    version: CANVAS_VERSION,
    revision: 0,
    confirmedRevision: 0,
    updatedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    markers: [],
  };
}

export type SaveResult = { ok: true; savedAt: string } | { ok: false; error: string };

/**
 * 保存一份快照。
 * @param doc 画布文档（revision 必须 ≥ 已存的）
 */
export function saveDocument(doc: CanvasDocument): SaveResult {
  try {
    const current = readJson<CanvasDocument>(docPath());
    // 单调性：拒绝倒退的 revision（除非是恢复流程显式回退，那种情况 revision 已经被下调）
    if (current && doc.revision < current.revision && doc.revision !== 0) {
      return { ok: false, error: `revision 倒退被拒绝：${doc.revision} < ${current.revision}` };
    }
    /*
     * ⚠️ C1：磁盘上的**格式版本比本代码新**时拒绝覆盖。
     *
     * 情形是"降级运行"（装了新版本、又换回旧版本）：旧程序不认识新格式，
     * 但它照旧会自动保存 —— 一写就把用户的新画布**降级销毁**。
     * 这一条的取舍与本项目 `§178.6 / §179.6 / §181.6` 一致：**不改用户文件，更保守**。
     */
    if (current && typeof current.version === "number" && current.version > CANVAS_VERSION) {
      return {
        ok: false,
        error: `磁盘上的画布是第 ${current.version} 版，本程序只认识到第 ${CANVAS_VERSION} 版，已拒绝覆盖`,
      };
    }
    const savedAt = new Date().toISOString();
    // 写出去的一律盖上当前版本号（渲染侧给的 version 不作为事实来源，这里才是）
    const next: CanvasDocument = { ...doc, version: CANVAS_VERSION, updatedAt: savedAt };
    writeJsonAtomic(docPath(), next);
    // 同时留一份"按 revision 命名"的历史，便于版本回溯与人工排查
    try {
      writeJsonAtomic(path.join(snapshotDir(), `rev-${doc.revision}.json`), next);
      pruneRevisions();
    } catch {
      /* 历史快照失败不影响主文档 */
    }
    return { ok: true, savedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 只保留最近 N 份历史快照。 */
const KEEP_REVISIONS = 20;

function pruneRevisions(): void {
  const dir = snapshotDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^rev-\d+\.json$/.test(f))
    .map((f) => ({ f, rev: Number(/^rev-(\d+)\.json$/.exec(f)?.[1] ?? 0) }))
    .sort((a, b) => a.rev - b.rev);
  for (const { f } of files.slice(0, Math.max(0, files.length - KEEP_REVISIONS))) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* 删不掉就算了 */
    }
  }
}

export type LoadResult = {
  doc: CanvasDocument;
  /** 是否发生了崩溃回退。 */
  recovered: boolean;
  /** 回退时丢弃了什么（用于界面提示）。 */
  recoveryNote?: string;
};

/**
 * 载入文档。发现"未确认快照"就判定上次异常退出，回退到确认版本。
 *
 * 回退成功时会把确认版**重新写回 `document.json`**：否则磁盘上留着的仍是那份
 * 未确认快照（revision 更大），紧接着的自动保存会被"修订号不能倒退"拒掉，
 * 界面卡在"保存失败"。回写之后就地和磁盘对齐了。
 */
export function loadDocument(): LoadResult {
  const loaded = readJson<CanvasDocument>(docPath());
  if (!loaded) return { doc: emptyDocument(), recovered: false };

  /*
   * ⚠️ C1：**先过前向迁移**，再谈别的。
   *
   * 以前 `version` 是个装饰品（写出去是 2，读回来没人看）。现在缺 `version` 的旧文件
   * 会被当成第 1 版补上标记层（`markers`）；**迁移要回写**，否则下一次自动保存
   * 又会把旧结构写回磁盘 —— 那就变成"每次启动都迁一遍"。
   */
  const migration = migrateCanvasDoc(loaded, emptyDocument);
  const doc = migration.doc;
  if (migration.migrated) {
    try {
      writeJsonAtomic(docPath(), doc);
      console.log("[canvas]", migration.note);
    } catch (error) {
      // 迁移写不回去不算失败：内容已经在内存里升上来了，下次再说
      console.error("[canvas] 迁移回写失败：", error instanceof Error ? error.message : error);
    }
  }
  if (migration.foreign) console.error("[canvas]", migration.note);

  // 正常关闭：revision 已被 ack
  if (doc.confirmedRevision >= doc.revision) return { doc, recovered: false };

  // 崩溃：回到最后确认的那一版
  const confirmed = readJson<CanvasDocument>(
    path.join(snapshotDir(), `rev-${doc.confirmedRevision}.json`),
  );
  if (confirmed) {
    const restored: CanvasDocument = {
      ...confirmed,
      revision: confirmed.confirmedRevision,
      confirmedRevision: confirmed.confirmedRevision,
      updatedAt: new Date().toISOString(),
    };
    try {
      writeJsonAtomic(docPath(), restored);
    } catch (error) {
      console.error("[canvas] 回退写盘失败：", error instanceof Error ? error.message : error);
    }
    return {
      doc: restored,
      recovered: true,
      recoveryNote: `上次未正常退出，已回退到第 ${restored.revision} 次修订（丢弃第 ${doc.revision} 次未确认快照）`,
    };
  }

  // 找不到确认版：保守地保留当前文档，但把 revision 标成已确认，避免每次都提示
  const kept: CanvasDocument = { ...doc, confirmedRevision: doc.revision };
  try {
    writeJsonAtomic(docPath(), kept);
  } catch {
    /* 写不进去也不该阻止用户看到内容 */
  }
  return {
    doc: kept,
    recovered: true,
    recoveryNote: `上次未正常退出，未找到可回退的确认快照，已沿用当前内容（第 ${doc.revision} 次修订）`,
  };
}

/** 确认某个 revision 已落盘（对标原版的 ack）。 */
export function ackDocument(revision: number): { ok: boolean } {
  const doc = readJson<CanvasDocument>(docPath());
  if (!doc) return { ok: false };
  const next: CanvasDocument = { ...doc, confirmedRevision: Math.max(doc.confirmedRevision, revision) };
  try {
    writeJsonAtomic(docPath(), next);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** 快照状态（给界面显示"已保存 / 未确认"）。 */
export function documentStatus(): CanvasSnapshotFile {
  const doc = readJson<CanvasDocument>(docPath());
  if (!doc) {
    return { revision: 0, confirmed: true, updatedAt: null, dir: snapshotDir() };
  }
  return {
    revision: doc.revision,
    confirmed: doc.confirmedRevision >= doc.revision,
    updatedAt: doc.updatedAt ?? null,
    dir: snapshotDir(),
  };
}

/** 列出历史快照（版本历史面板用）。 */
export function listRevisions(): Array<{ revision: number; updatedAt: string }> {
  const dir = snapshotDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^rev-\d+\.json$/.test(f))
    .map((f) => {
      const doc = readJson<CanvasDocument>(path.join(dir, f));
      return { revision: doc?.revision ?? 0, updatedAt: doc?.updatedAt ?? "" };
    })
    .filter((r) => r.revision > 0)
    .sort((a, b) => b.revision - a.revision);
}

/**
 * 读取某个历史版本（版本历史面板的"预览此版本"）。
 * @param revision 目标修订号
 * @returns 该版本的文档；不存在返回 null
 */
export function readRevision(revision: number): CanvasDocument | null {
  if (!Number.isInteger(revision) || revision < 0) return null;
  return readJson<CanvasDocument>(path.join(snapshotDir(), `rev-${revision}.json`));
}

/**
 * 回滚到某个历史版本。
 *
 * 做法：把该版本的内容**写成一个新的、更大的修订号**，而不是把修订号改回去 ——
 * 修订号必须单调（对标原版 `documentRevision` 的约束），否则后续保存会被拒。
 * 回滚本身也是一次"内容变更"，所以它同样进历史、同样可被再次回滚。
 *
 * @param revision 要回到的修订号
 * @returns 新文档（带新的修订号），失败返回原因
 */
export function restoreRevision(revision: number): { ok: true; doc: CanvasDocument } | { ok: false; error: string } {
  const target = readRevision(revision);
  if (!target) return { ok: false, error: `找不到第 ${revision} 次修订的快照` };
  const current = readJson<CanvasDocument>(docPath());
  const nextRevision = Math.max(current?.revision ?? 0, revision) + 1;
  const restored: CanvasDocument = {
    ...target,
    revision: nextRevision,
    confirmedRevision: nextRevision,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeJsonAtomic(docPath(), restored);
    writeJsonAtomic(path.join(snapshotDir(), `rev-${nextRevision}.json`), restored);
    pruneRevisions();
    return { ok: true, doc: restored };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
