import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import type { SessionSearchHit, ShellBridge } from "@shared/ipc";
import { splitTurns, type LogRecord } from "@engine/core/events";

import { useWorkbenchStore } from "./store";
import { useSearchHistoryStore } from "./searchHistoryStore";
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
 * ## 结果的三种归宿（V6-2a 起不再有"点了没反应"）
 *
 * · `task-<id>` 且任务还在 → **可打开**（点了进那个任务）；
 * · 任务已被删掉 → 只给片段（不给一个"打开就报任务不存在"的假入口）；
 * · `chat-` / `cli-` 记录 → **应用内预览**（点了在下面展开逐轮正文；
 *   以前是死 div，理由是"没有查看页"——现在有了，虽然只是一个预览面板）。
 *
 * 另外：搜过的词会进 `sessions` 搜索历史（回车或点中结果时记），
 * 下次打开搜索框能直接点回来。
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
  /** 非任务会话的预览（V6-2a：点了能看见逐轮正文，不再是一个点不动的 div）。 */
  const [peek, setPeek] = useState<{ id: string; lines: { role: string; text: string }[] } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const tasks = useWorkbenchStore((s) => s.tasks);
  const openTask = useWorkbenchStore((s) => s.openTask);
  const sessionHistory = useSearchHistoryStore((s) => s.history.sessions);
  const recordSearch = useSearchHistoryStore((s) => s.record);
  const loadHistory = useSearchHistoryStore((s) => s.load);

  /* 打开搜索框时把历史读进来（磁盘是权威；读失败不影响搜索本身） */
  useEffect(() => {
    if (open) void loadHistory();
  }, [open, loadHistory]);

  /** 读一段非任务会话并展开（chat- / cli-）。 */
  const openPeek = async (sessionId: string): Promise<void> => {
    const api = (globalThis as { shell?: ShellBridge }).shell;
    if (!api?.session) return;
    try {
      const got = await api.session.load(sessionId);
      const turns = splitTurns((got.records ?? []) as LogRecord[]);
      const lines: { role: string; text: string }[] = [];
      for (const turn of turns) {
        const user = [...(turn.request?.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
        if (user) lines.push({ role: "user", text: user });
        if (turn.view.text) lines.push({ role: "assistant", text: turn.view.text });
      }
      setPeek({ id: sessionId, lines });
      setError("");
    } catch (err) {
      setError(`打不开这段会话：${String((err as Error)?.message ?? err)}`);
    }
  };

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

  const remember = (word: string): void => {
    if (word.trim().length >= MIN_CHARS) recordSearch("sessions", word.trim());
  };

  const pick = (id: string): void => {
    remember(query);
    openTask(id);
    setOpen(false);
    setQuery("");
    setPeek(null);
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
            onChange={(e) => {
              setQuery(e.target.value);
              setPeek(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") remember(q);
            }}
          />
          <div className="wb-navsearch-list" data-testid="wb-navsearch-list">
            {q.length < MIN_CHARS ? (
              sessionHistory.length ? (
                <div data-testid="wb-navsearch-history" style={{ padding: "6px 8px" }}>
                  <div className="wb-navsearch-empty" style={{ marginBottom: 4 }}>
                    最近搜过
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {sessionHistory.map((word) => (
                      <button
                        key={word}
                        type="button"
                        className="wb-chip"
                        data-testid={`wb-navsearch-history-${word}`}
                        onClick={() => setQuery(word)}
                      >
                        {word}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="wb-navsearch-empty">输入至少 {MIN_CHARS} 个字开始搜索（检索的是会话记录正文）</div>
              )
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
                  /* 非任务会话（chat- / cli-）：点开在应用内预览逐轮正文（V6-2a） */
                  <button
                    key={h.sessionId}
                    className="wb-navsearch-hit"
                    data-testid={`wb-navsearch-hit-${h.sessionId}`}
                    title="查看这段会话的正文"
                    onClick={() => {
                      remember(q);
                      void openPeek(h.sessionId);
                    }}
                  >
                    {body}
                  </button>
                );
              })
            )}
          </div>
          {peek ? (
            <div
              className="wb-navsearch-peek"
              data-testid="wb-navsearch-peek"
              style={{ borderTop: "1px solid var(--line, #ddd)", padding: "6px 8px", maxHeight: 240, overflow: "auto" }}
            >
              <div className="wb-navsearch-head" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <b>{peek.id}</b>
                <button type="button" className="wb-chip" data-testid="wb-navsearch-peek-close" onClick={() => setPeek(null)}>
                  收起
                </button>
              </div>
              {peek.lines.length ? (
                peek.lines.map((line, index) => (
                  <div key={`${line.role}-${index}`} style={{ marginTop: 4 }}>
                    <em className="wb-navsearch-kind">{line.role === "user" ? "用户" : "助手"}</em>{" "}
                    <span style={{ whiteSpace: "pre-wrap" }}>{line.text}</span>
                  </div>
                ))
              ) : (
                <div className="wb-navsearch-empty">这段会话没有可显示的正文字（可能只有工具事件）。</div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
