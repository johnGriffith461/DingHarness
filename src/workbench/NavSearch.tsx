import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import type { SessionSearchHit } from "@shared/ipc";

import { useWorkbenchStore } from "./store";
import { hitKindLabel, openableTaskId, searchSessions } from "./sessionSearch";

/**
 * 左栏搜索（2026-10-17，V5 开工前清尾 #3）。
 *
 * ## 这颗键的来历
 *
 * 它原来是个**装饰**：`disabled` + title 写着"本机版是装饰：仿浏览器工具条"。
 * V5 开工前清尾的口径是「真做」—— 接 Phase 12.4 的会话全文检索（基础设施早就有：
 * store 层的 FTS + LIKE 并集，CLI 的 `ding sessions --search` 一直在用同一个口子）。
 *
 * ## 结果的三种归宿（诚实优先）
 *
 * · `task-<id>` 且任务还在 → **可打开**（点了进那个任务）；
 * · 任务已被删掉 → 只给片段（不给一个"打开就报任务不存在"的假入口）；
 * · `chat-` / `cli-` 记录 → 只给片段（本机版没有它们的查看页，不做假按钮）。
 *
 * 检索的是**会话记录正文**（不是标题）—— 空态文案里写清楚，免得用户以为坏了。
 */

/** 输几个字才开始搜（一个字太泛，也省着打库）。 */
const MIN_CHARS = 2;
/** 打字防抖（毫秒）。 */
const DEBOUNCE_MS = 220;

export function NavSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  const tasks = useWorkbenchStore((s) => s.tasks);
  const openTask = useWorkbenchStore((s) => s.openTask);

  /* 点外面 / Esc 关掉 —— 与 SkillPanel / AccountMenu 同一条手感规矩 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (rootRef.current && t && !rootRef.current.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /* 打字 → 防抖检索（序号防竞态：慢的那次回来不覆盖新的一次） */
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setLoading(false);
      setHits([]);
      setError("");
      return;
    }
    setLoading(true);
    let alive = true;
    const timer = setTimeout(() => {
      void searchSessions(q).then((got) => {
        if (!alive) return;
        setLoading(false);
        if (got.ok) {
          setHits(got.hits);
          setError("");
        } else {
          setHits([]);
          setError(got.error);
        }
      });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  const pick = (id: string): void => {
    openTask(id);
    setOpen(false);
    setQuery("");
  };

  const q = query.trim();

  return (
    <div className="wb-navsearch-wrap" ref={rootRef}>
      <button
        className={`wb-icon${open ? " is-on" : ""}`}
        aria-label="搜索"
        title="搜索会话记录"
        data-testid="wb-search"
        onClick={() => setOpen((v) => !v)}
      >
        <Search size={14} />
      </button>
      {open ? (
        <div className="wb-navsearch" data-testid="wb-navsearch">
          <input
            className="wb-navsearch-input"
            data-testid="wb-navsearch-input"
            placeholder="搜索会话记录…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="wb-navsearch-list" data-testid="wb-navsearch-list">
            {q.length < MIN_CHARS ? (
              <div className="wb-navsearch-empty">输入至少 {MIN_CHARS} 个字开始搜索（检索的是会话记录正文）</div>
            ) : loading ? (
              <div className="wb-navsearch-empty">搜索中…</div>
            ) : error ? (
              <div className="wb-navsearch-empty">{error}</div>
            ) : hits.length === 0 ? (
              <div className="wb-navsearch-empty">没搜到「{q}」。检索的是会话记录正文，换个词试试。</div>
            ) : (
              hits.map((h) => {
                const taskId = openableTaskId(h, (id) => tasks.some((t) => t.id === id));
                /* 能打开的一律标「任务」——裸任务 id 那条路按前缀判不出来（见 sessionSearch.ts 的说明） */
                const label = taskId ? "任务" : hitKindLabel(h.sessionId);
                const body = (
                  <>
                    <span className="wb-navsearch-head">
                      <em className="wb-navsearch-kind">{label}</em>
                      <b>{h.title || h.sessionId}</b>
                      <span className="wb-navsearch-count">命中 {h.hits} 处</span>
                    </span>
                    <span className="wb-navsearch-excerpt">{h.excerpt}</span>
                  </>
                );
                return taskId ? (
                  <button
                    key={h.sessionId}
                    className="wb-navsearch-hit"
                    data-testid={`wb-navsearch-hit-${h.sessionId}`}
                    title="打开这个任务"
                    onClick={() => pick(taskId)}
                  >
                    {body}
                  </button>
                ) : (
                  /* 只读行：不是一个控件（不给点不动的假按钮），但内容如实给出 */
                  <div
                    key={h.sessionId}
                    className="wb-navsearch-hit is-readonly"
                    data-testid={`wb-navsearch-hit-${h.sessionId}`}
                  >
                    {body}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
