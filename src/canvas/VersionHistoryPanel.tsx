import { useCallback, useEffect, useState } from "react";
import { History, RotateCcw, X } from "lucide-react";
import type { CanvasDocument, ShellBridge } from "@shared/ipc";
import { useRuntimeStore } from "./runtimeStore";
import { droppedCount, normalizeCanvasDoc } from "./normalizeDoc";
import { uiError } from "./uiError";

/**
 * 版本历史面板（对标原版 `canvas_versions_*`）。
 *
 * 原版的能力：列出历史版本、能"回到最新版本"、能"恢复此版本"、
 * 且明确提示旧版本不可直接编辑（`canvas_old_version_uneditable_info`）。
 *
 * 这里的分工：
 *   · 主进程负责列版本、读版本、写回滚（修订号单调，见 snapshotStore.restoreRevision）
 *   · 本面板只负责展示与触发；预览用只读快照，不直接改画布——
 *     只有点「恢复此版本」才真正落成一次新的修订
 */

const bridge = (): ShellBridge | undefined =>
  (globalThis as unknown as { shell?: ShellBridge }).shell;

type RevisionItem = { revision: number; updatedAt: string };

export default function VersionHistoryPanel({
  open,
  onClose,
  currentRevision,
}: {
  open: boolean;
  onClose: () => void;
  /** 当前画布的修订号（用于标出"最新"）。 */
  currentRevision: number;
}) {
  const [items, setItems] = useState<RevisionItem[]>([]);
  const [preview, setPreview] = useState<{ revision: number; doc: CanvasDocument } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const shell = bridge();
    if (!shell?.canvas) {
      setNote("版本历史需要 Electron 主进程（当前在浏览器里运行）");
      return;
    }
    try {
      setItems(await shell.canvas.revisions());
    } catch (error) {
      /* 上游那句话不许原样贴出来（P190）：`uiError` 压成一句人话，认不出来就说「没料到的问题」 */
      setNote(`读取版本列表失败：${uiError(error)}`);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, currentRevision]);

  const openPreview = useCallback(async (revision: number) => {
    const shell = bridge();
    if (!shell?.canvas) return;
    const doc = await shell.canvas.readRevision(revision);
    if (!doc) {
      setNote(`第 ${revision} 次修订的快照已不在本地`);
      return;
    }
    setPreview({ revision, doc });
  }, []);

  const restore = useCallback(
    async (revision: number) => {
      const shell = bridge();
      if (!shell?.canvas) return;
      setBusy(true);
      setNote(null);
      try {
        const result = await shell.canvas.restore(revision);
        if (!result.ok) {
          setNote(result.error);
          return;
        }
        const doc = result.doc;
        /*
         * ⚠️⚠️ **恢复也要过一遍清洗**（2026-10-16 审计 P26）。
         *
         * 原来这里是三句裸断言（`doc.nodes as CanvasNode[]` / `as never[]` / `as Marker[]`）——
         * 与 `usePersistence` 载入时**必须洗**的理由完全一样（§181）：历史快照是
         * **更早的代码**写出来的，节点缺 `position`、连线指向不存在的节点、标记用旧字段
         * 都会在这里直接进 react-flow。而恢复恰恰是用户"东西看着不对了"才做的动作 ——
         * 这时候给他一屏烂节点，等于把唯一一条退路也堵了。
         */
        const clean = normalizeCanvasDoc(doc);
        const store = useRuntimeStore.getState();
        store.loadDocument({
          nodes: clean.nodes,
          edges: clean.edges,
          viewport: clean.viewport,
          revision: doc.revision,
          markers: clean.markers,
        });
        setPreview(null);
        await refresh();
        const dropped = droppedCount(clean);
        setNote(
          `已恢复到第 ${revision} 次修订的内容（记为新的第 ${doc.revision} 次修订）` +
            (dropped > 0 ? `；有 ${dropped} 个元素读不进来（版本不对或数据不完整），已跳过` : ""),
        );
      } catch (error) {
        /* 同上：恢复失败也可能是上游（主进程 / 文件系统）抛的，同样过一遍人话 */
        setNote(`恢复失败：${uiError(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  if (!open) return null;

  const fmt = (iso: string) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <aside className="versions-panel" data-testid="versions-panel">
      <div className="versions-head">
        <span className="versions-title">
          <History size={13} /> 版本历史
        </span>
        <button className="versions-icon" onClick={onClose} aria-label="关闭" title="关闭">
          <X size={13} />
        </button>
      </div>

      <div className="versions-list" data-testid="versions-list">
        <div className="versions-item is-latest">
          <div className="versions-item-main">
            <span className="versions-item-name">最新版本</span>
            <span className="versions-item-time">rev {currentRevision}</span>
          </div>
          <span className="versions-badge">当前</span>
        </div>

        {items.map((item) => (
          <div className="versions-item" key={item.revision}>
            <div className="versions-item-main">
              <span className="versions-item-name">第 {item.revision} 次修订</span>
              <span className="versions-item-time">{fmt(item.updatedAt)}</span>
            </div>
            <div className="versions-actions">
              <button
                className="versions-mini"
                data-testid={`version-preview-${item.revision}`}
                onClick={() => void openPreview(item.revision)}
                title="预览此版本（只读）"
              >
                预览
              </button>
              <button
                className="versions-mini is-primary"
                data-testid={`version-restore-${item.revision}`}
                disabled={busy}
                onClick={() => void restore(item.revision)}
                title="把画布恢复到这一版（会记成一次新的修订）"
              >
                <RotateCcw size={11} /> 恢复此版本
              </button>
            </div>
          </div>
        ))}

        {items.length === 0 ? (
          <div className="versions-empty">还没有历史版本 —— 画布每次变更都会自动存一版</div>
        ) : null}
      </div>

      {preview ? (
        <div className="versions-preview" data-testid="versions-preview">
          <div className="versions-preview-head">
            预览：第 {preview.revision} 次修订
            <button className="versions-icon" onClick={() => setPreview(null)} title="退出预览">
              <X size={12} />
            </button>
          </div>
          <div className="versions-preview-body">
            <div>节点 {preview.doc.nodes.length} 个</div>
            <div>连线 {preview.doc.edges.length} 条</div>
            <div>标记 {(preview.doc.markers ?? []).length} 个</div>
            <div className="versions-preview-note">旧版本不可直接编辑，点「恢复此版本」才会落成新修订</div>
          </div>
        </div>
      ) : null}

      {note ? (
        <div className="versions-note" onClick={() => setNote(null)} title="点击关闭">
          {note}
        </div>
      ) : null}
    </aside>
  );
}
