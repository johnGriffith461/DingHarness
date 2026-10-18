import { app, dialog, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

import { openKnowledgeStore, type KnowledgeDoc, type KnowledgeHit } from "../../engine/rag/store";
import type {
  KnowledgeAddFileResult,
  KnowledgeAddTextInput,
  KnowledgeDocWire,
  KnowledgeHitWire,
} from "../../shared/knowledgeWire";

/**
 * **知识库的桌面 IPC**（G15）。
 *
 * 与 CLI 的 `ding knowledge` 用**同一个库文件**（`<userData>/knowledge.db`，引擎
 * `engine/rag/store.ts`）—— 两套存储会立刻出现"CLI 灌进去的桌面搜不到"。
 *
 * ## 三件必须守住的
 *
 * 1. **只收文本文件**：面板导入走系统文件对话框（路径来自主进程，渲染层注入不了）；
 *    读进来先当 UTF-8 文本，二进制（含 NUL 字节）直接拒并说明；
 * 2. **大小上限**：2MB —— 再大就不是"一段能检索的资料"，而是整个仓库；
 * 3. **viewer 固定 `local`**：本机单用户；`team` 域的数据本机也看得到（与 store 的可见性一致）。
 */

export const KNOWLEDGE_CHANNEL = {
  list: "knowledge:list",
  addText: "knowledge:add-text",
  addFile: "knowledge:add-file",
  search: "knowledge:search",
  remove: "knowledge:remove",
} as const;

/** 单个文件的上限（2MB）。 */
export const KNOWLEDGE_MAX_BYTES = 2 * 1024 * 1024;

/** 允许导入的扩展名（都是纯文本；Office/PDF 需要各自的解析器，未做就说未做）。 */
export const KNOWLEDGE_TEXT_EXT = [".md", ".markdown", ".txt", ".text", ".json", ".csv", ".log", ".ts", ".tsx", ".js", ".py", ".yml", ".yaml"] as const;

/** 本机查看者 id（与 `space` 的 owner 同一个 id 空间）。 */
const VIEWER = "local";

function dbDir(): string {
  return app.getPath("userData");
}

function withStore<T>(fn: (store: ReturnType<typeof openKnowledgeStore>) => T): T {
  const store = openKnowledgeStore(dbDir());
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** `KnowledgeDoc` → 线上形状（只挑界面要用的字段）。 */
export function toDocWire(doc: KnowledgeDoc): KnowledgeDocWire {
  return {
    id: doc.id,
    path: doc.path,
    title: doc.title,
    domain: doc.domain,
    owner: doc.owner,
    bytes: doc.bytes,
    addedAt: doc.addedAt,
    chunks: doc.chunks,
  };
}

/** `KnowledgeHit` → 线上形状。 */
export function toHitWire(hit: KnowledgeHit): KnowledgeHitWire {
  return {
    docId: hit.docId,
    path: hit.path,
    title: hit.title,
    domain: hit.domain,
    ordinal: hit.ordinal,
    text: hit.text,
    score: hit.score,
    citation: hit.citation,
  };
}

/** 注册知识库 IPC。 */
export function registerKnowledgeIpc(ipc: Electron.IpcMain, getWindow: () => BrowserWindow | null): void {
  ipc.handle(KNOWLEDGE_CHANNEL.list, () =>
    withStore((store) => ({ docs: store.list(VIEWER).map(toDocWire), file: store.file })),
  );

  ipc.handle(KNOWLEDGE_CHANNEL.addText, (_e, input: KnowledgeAddTextInput) => {
    const title = String(input?.title ?? "").trim();
    const text = String(input?.text ?? "");
    if (!title) return { ok: false, error: "标题不能为空（检索结果要靠它引用）" };
    if (!text.trim()) return { ok: false, error: "内容是空的" };
    if (Buffer.byteLength(text, "utf8") > KNOWLEDGE_MAX_BYTES) {
      return { ok: false, error: `内容超过 ${KNOWLEDGE_MAX_BYTES / 1024 / 1024}MB —— 知识库适合放"能读完的一段资料"` };
    }
    return withStore((store) => {
      const got = store.addDocument({
        path: `paste://${title}`,
        title,
        text,
        domain: input?.domain === "team" ? "team" : "private",
        owner: VIEWER,
      });
      return { ok: true as const, doc: toDocWire(got.doc), replaced: got.replaced };
    });
  });

  ipc.handle(KNOWLEDGE_CHANNEL.addFile, async () => {
    const win = getWindow();
    if (!win) return { ok: false, canceled: true, error: "没有窗口可挂文件对话框" } satisfies KnowledgeAddFileResult;
    const picked = await dialog.showOpenDialog(win, {
      title: "选一份要放进知识库的文本文件",
      properties: ["openFile"],
      filters: [{ name: "文本", extensions: KNOWLEDGE_TEXT_EXT.map((e) => e.slice(1)) }],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true } satisfies KnowledgeAddFileResult;
    const file = picked.filePaths[0]!;
    const ext = path.extname(file).toLowerCase();
    if (!KNOWLEDGE_TEXT_EXT.includes(ext as (typeof KNOWLEDGE_TEXT_EXT)[number])) {
      return { ok: false, error: `只收文本类文件（${KNOWLEDGE_TEXT_EXT.join(" / ")}）；Office/PDF 暂不支持` };
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch (error) {
      return { ok: false, error: `读不了这个文件：${String((error as Error)?.message ?? error)}` };
    }
    if (buf.length > KNOWLEDGE_MAX_BYTES) {
      return { ok: false, error: `文件超过 ${KNOWLEDGE_MAX_BYTES / 1024 / 1024}MB，先拆小再导入` };
    }
    if (buf.includes(0)) return { ok: false, error: "看着不是文本文件（含 NUL 字节）" };
    const text = buf.toString("utf8");
    return withStore((store) => {
      const got = store.addDocument({
        path: file,
        title: path.basename(file),
        text,
        domain: "private",
        owner: VIEWER,
      });
      return { ok: true as const, doc: toDocWire(got.doc), path: file } satisfies KnowledgeAddFileResult;
    });
  });

  ipc.handle(KNOWLEDGE_CHANNEL.search, (_e, query: string) => {
    const q = String(query ?? "").trim();
    if (!q) return { hits: [] as KnowledgeHitWire[] };
    return withStore((store) => ({ hits: store.search(q, { viewer: VIEWER, limit: 10 }).map(toHitWire) }));
  });

  ipc.handle(KNOWLEDGE_CHANNEL.remove, (_e, idOrPath: string) =>
    withStore((store) => store.removeDocument(String(idOrPath ?? ""))),
  );
}
