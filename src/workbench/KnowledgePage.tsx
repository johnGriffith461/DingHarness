import { useEffect, useState } from "react";
import { FilePlus2, Search, Trash2 } from "lucide-react";

import type { ShellBridge } from "@shared/ipc";
import type { KnowledgeDocWire, KnowledgeHitWire } from "@shared/knowledgeWire";

/**
 * **本地知识库**（G15 的桌面面板）。
 *
 * ## 它解决什么
 *
 * `knowledge_search` 工具与 `ding knowledge` 早就能用，但桌面**没有地方传资料** ——
 * 用户得开命令行。这一页把三件事放到一起：**导入（文件 / 粘贴）→ 搜索 → 看引用**。
 *
 * ## 三条如实说明（写在界面上，不只写在注释里）
 *
 * 1. 只收**文本类**文件（2MB 以内）；Office/PDF 需要解析器，暂未支持；
 * 2. 检索是 **FTS5 + LIKE 混合**（本地、零模型调用），不是向量语义检索 ——
 *    "报销流程"不会自动命中"费用审批步骤"；
 * 3. 数据在 `<数据目录>/knowledge.db`，与 `ding knowledge` 是同一个文件；
 *    这里的「私有 / 团队」域与 CLI 的可见性规则一致（team 对所有人可见）。
 */

function shell(): ShellBridge | null {
  return (globalThis as { shell?: ShellBridge }).shell ?? null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function KnowledgePage() {
  const [docs, setDocs] = useState<KnowledgeDocWire[]>([]);
  const [file, setFile] = useState("");
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHitWire[]>([]);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    const api = shell();
    if (!api?.knowledge) {
      setNote("这个宿主没有接知识库（只有桌面版有）");
      return;
    }
    try {
      const got = await api.knowledge.list();
      setDocs(got.docs);
      setFile(got.file);
    } catch (error) {
      setNote(`读取失败：${String((error as Error)?.message ?? error)}`);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const addFile = async (): Promise<void> => {
    const api = shell();
    if (!api?.knowledge) return;
    setBusy(true);
    try {
      const got = await api.knowledge.addFile();
      if (!got.ok) {
        setNote(got.canceled ? "已取消" : `导入失败：${got.error ?? "未知原因"}`);
        return;
      }
      setNote(`已导入「${got.doc.title}」（${got.doc.chunks} 段）`);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const addText = async (): Promise<void> => {
    const api = shell();
    if (!api?.knowledge) return;
    setBusy(true);
    try {
      const got = await api.knowledge.addText({ title, text });
      setNote(got.ok ? `已保存「${got.doc.title}」（${got.doc.chunks} 段）` : `没存上：${got.error}`);
      if (got.ok) {
        setTitle("");
        setText("");
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const search = async (): Promise<void> => {
    const api = shell();
    if (!api?.knowledge) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    const got = await api.knowledge.search(q);
    setHits(got.hits);
    setNote(got.hits.length ? `命中 ${got.hits.length} 段` : "没有命中 —— 资料里没有就说没有");
  };

  const remove = async (doc: KnowledgeDocWire): Promise<void> => {
    const api = shell();
    if (!api?.knowledge) return;
    const got = await api.knowledge.remove(doc.id);
    setNote(got.removed ? `已删除「${doc.title}」` : "没删掉（可能已经被删了）");
    await refresh();
  };

  return (
    <div className="wb-setpage-body" data-testid="wb-knowledge">
      <div className="wb-setpage-row">
        <span className="wb-setpage-label">导入文件</span>
        <button className="wb-setpage-btn" data-testid="wb-knowledge-add-file" disabled={busy} onClick={() => void addFile()}>
          <FilePlus2 size={13} /> 选一个文本文件
        </button>
      </div>
      <div className="wb-setpage-note">
        只收文本类（.md / .txt / .json / .csv / 代码，≤2MB）；Office/PDF 暂不支持。数据在 {file || "…"}。
      </div>

      <div className="wb-setpage-row" style={{ alignItems: "flex-start" }}>
        <span className="wb-setpage-label">粘贴一段</span>
        <div style={{ display: "grid", gap: 6, flex: 1 }}>
          <input
            className="wb-setpage-select"
            data-testid="wb-knowledge-title"
            placeholder="标题（检索结果靠它引用）"
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="wb-setpage-select"
            data-testid="wb-knowledge-text"
            placeholder="把要记住的资料粘贴进来"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            className="wb-setpage-btn"
            data-testid="wb-knowledge-save"
            disabled={busy || !title.trim() || !text.trim()}
            onClick={() => void addText()}
          >
            存进知识库
          </button>
        </div>
      </div>

      <div className="wb-setpage-row">
        <span className="wb-setpage-label">搜索</span>
        <div style={{ display: "flex", gap: 6, flex: 1 }}>
          <input
            className="wb-setpage-select"
            data-testid="wb-knowledge-query"
            placeholder="搜一个词或一句话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search();
            }}
          />
          <button className="wb-setpage-btn" data-testid="wb-knowledge-search" onClick={() => void search()}>
            <Search size={13} /> 搜索
          </button>
        </div>
      </div>
      {hits.length ? (
        <ul className="wb-setpage-body" data-testid="wb-knowledge-hits" style={{ paddingLeft: 18 }}>
          {hits.map((hit, i) => (
            <li key={`${hit.docId}-${hit.ordinal}`} style={{ marginBottom: 8 }}>
              <b>
                [{i + 1}] {hit.title}
              </b>
              <span className="wb-card-desc">（{hit.citation || hit.path}）</span>
              <div className="wb-card-desc" style={{ whiteSpace: "pre-wrap" }}>
                {hit.text.slice(0, 300)}
                {hit.text.length > 300 ? "…" : ""}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="wb-setpage-row">
        <span className="wb-setpage-label">已收录</span>
        <em>{docs.length ? `${docs.length} 份` : "还没有"}</em>
      </div>
      <ul className="wb-setpage-body" data-testid="wb-knowledge-docs" style={{ paddingLeft: 18 }}>
        {docs.map((doc) => (
          <li key={doc.id} style={{ marginBottom: 6, display: "flex", gap: 8, alignItems: "center" }}>
            <span>
              <b>{doc.title}</b>{" "}
              <span className="wb-card-desc">
                {doc.domain === "team" ? "团队" : "私有"} · {doc.chunks} 段 · {fmtBytes(doc.bytes)}
              </span>
            </span>
            <button
              className="wb-chip"
              title="从知识库删除"
              aria-label={`删除 ${doc.title}`}
              data-testid={`wb-knowledge-remove-${doc.id.slice(0, 8)}`}
              onClick={() => void remove(doc)}
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>

      <div className="wb-setpage-note">
        检索是本地 FTS5 + LIKE 混合（零模型调用），不是向量语义检索；「答得像」不算数，
        每条命中都带原文出处，可以点开核对。
      </div>
      {note ? (
        <div className="wb-setpage-note" role="status" data-testid="wb-knowledge-note">
          {note}
        </div>
      ) : null}
    </div>
  );
}
