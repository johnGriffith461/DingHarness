import { useCallback, useEffect, useState } from "react";
import type { ShellBridge } from "@shared/ipc";
import { lineDiff } from "@engine/runtime/fileReview";

/**
 * **本段对话的逐文件改动**（U08 桌面那一半，2026-10-18）。
 *
 * 能力本体在 engine（`fileReview.ts`，有单测）；这条界面只是把
 * `shell.review.list()` 的结果摆出来：每个文件改了几处、逐段 diff、
 * 以及一个**按文件回滚**的按钮。
 *
 * ## 三条诚实口径
 *
 * 1. **默认收起**：改动清单不抢正文；用户想看时才展开（展开才去读日志 —— 没有待看的东西不该有开销）。
 * 2. **回滚只对可证明的改动**：`write_file` 覆盖已有文件时日志里没有原件，
 *    那一行写明"不可回滚"，按钮不画（画了就是个点了会失败的按钮）。
 * 3. **回滚之后重新拉一遍**：状态以主进程返回的为准，不在前端自己删条目
 *    （前端删了、盘上没回滚，那是最坏的一种"看起来好了"）。
 */

const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

/** 一条改动（与 IPC 契约同形）。 */
type ChangeView = {
  toolCallId: string;
  tool: "write_file" | "edit_file";
  path: string;
  line: string;
  before?: string;
  after?: string;
  reversible: boolean;
  why?: string;
};

type Loaded = {
  summary: { files: number; edits: number; writes: number; reversible: number };
  files: Array<{ path: string; changes: ChangeView[] }>;
};

export function ChangeReviewPanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const review = bridge()?.review;
    if (!review) return;
    try {
      const got = (await review.list(sessionId)) as { ok: true } & Loaded | { ok: false; error: string };
      if (!got.ok) {
        setError(got.error);
        setLoaded(null);
        return;
      }
      setLoaded({ summary: got.summary, files: got.files });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

  /* 展开时才读（默认收起 = 没有开销） */
  useEffect(() => {
    if (open && !loaded) void load();
  }, [open, loaded, load]);

  const revert = async (path: string): Promise<void> => {
    const review = bridge()?.review;
    if (!review || busy) return;
    setBusy(path);
    setNote("");
    try {
      const got = (await review.revert(sessionId, path)) as { ok: true; reverted: number } | { ok: false; error: string };
      setNote(got.ok ? `已回滚 ${path}（${got.reverted} 处）` : `没能回滚：${got.error}`);
      /* 以主进程为准重新拉一遍 */
      await load();
    } catch (cause) {
      setNote(`没能回滚：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="wb-review" data-testid="wb-review">
      <button
        type="button"
        className="wb-review-toggle"
        data-testid="wb-review-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "收起本段改动" : "看本段改了什么"}
      </button>
      {open ? (
        <div className="wb-review-body" data-testid="wb-review-body">
          {error ? <div className="wb-review-error">{error}</div> : null}
          {!loaded && !error ? <div className="wb-review-hint">正在读这段会话的改动…</div> : null}
          {loaded && loaded.files.length === 0 ? (
            <div className="wb-review-hint" data-testid="wb-review-empty">
              这段对话没有写/改过文件。
            </div>
          ) : null}
          {loaded && loaded.files.length > 0 ? (
            <>
              <div className="wb-review-summary" data-testid="wb-review-summary">
                共 {loaded.summary.files} 个文件：{loaded.summary.edits} 处编辑 / {loaded.summary.writes} 次写入
                （可回滚 {loaded.summary.reversible} 处）
              </div>
              {loaded.files.map((group) => (
                <details key={group.path} className="wb-review-file" data-testid={`wb-review-file-${group.path}`}>
                  <summary>
                    <span className="wb-review-path">{group.path}</span>
                    <span className="wb-review-count">{group.changes.length} 处</span>
                  </summary>
                  {group.changes.map((change) => (
                    <div key={change.toolCallId} className="wb-review-change">
                      <div className="wb-review-line">{change.line}</div>
                      {change.tool === "edit_file" && change.before !== undefined && change.after !== undefined ? (
                        <pre className="wb-review-diff">
                          {lineDiff(change.before, change.after, { maxLines: 60 })
                            .map((line) => `${line.kind}${line.text}`)
                            .join("\n")}
                        </pre>
                      ) : null}
                      {change.reversible ? (
                        <button
                          type="button"
                          className="wb-review-revert"
                          data-testid={`wb-review-revert-${change.toolCallId}`}
                          disabled={Boolean(busy)}
                          onClick={() => void revert(group.path)}
                        >
                          {busy === group.path ? "回滚中…" : "回滚这个文件"}
                        </button>
                      ) : (
                        <div className="wb-review-hint">⚠️ {change.why ?? "这份改动没有留下原件，不能回滚"}</div>
                      )}
                    </div>
                  ))}
                </details>
              ))}
              {note ? (
                <div className="wb-review-note" data-testid="wb-review-note">
                  {note}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
