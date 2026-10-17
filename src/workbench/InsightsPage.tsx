import { useEffect, useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";

import type { ShellBridge, TurnTraceView, UsageSummaryView } from "@shared/ipc";
import { formatCount } from "@shared/cost";
import { NavCollapseButton } from "./NavCollapseButton";

/**
 * 用量与请求追踪（V6-2c / V6-2d）。
 *
 * ## 数据从哪来
 *
 * 只从**已有的事件日志**算（`engine/adapters/sqliteStats.ts`）：
 * 每轮开头是 `request`（provider/model），收尾是 `done`（usage/elapsedMs）。
 * 不另记遥测、不上报 —— 本地主权品牌的信誉项，这一页自己就是证据。
 *
 * ## 为什么分成两栏
 *
 * - **用量**回答"花了多少"（90 天趋势 + 按模型拆分）；
 * - **追踪**回答"这一轮为什么慢/为什么失败"（30 天逐轮，含耗时与工具次数）。
 *
 * ⚠️ 失败那轮**不计入用量**（usage 可能只报了一部分，混进去会让账单口径失真）；
 * 它在追踪栏里照样能看到失败原因。
 */

function shell(): ShellBridge | null {
  return (globalThis as { shell?: ShellBridge }).shell ?? null;
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function InsightsPage() {
  const [tab, setTab] = useState<"usage" | "traces">("usage");
  const [usage, setUsage] = useState<UsageSummaryView | null>(null);
  const [traces, setTraces] = useState<TurnTraceView[]>([]);
  const [note, setNote] = useState("正在读取本机会话日志…");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyFailed, setOnlyFailed] = useState(false);

  const refresh = async () => {
    const api = shell();
    if (!api?.stats) {
      setNote("这一页要在桌面端打开（浏览器预览里没有本机日志）。");
      return;
    }
    setBusy(true);
    try {
      const [u, t] = await Promise.all([api.stats.usage({ days: 90 }), api.stats.turns({ days: 30, limit: 800 })]);
      setUsage(u);
      setTraces(t);
      setNote(
        u.totals.turns || t.length
          ? `用量窗口 ${u.byDay.length} 天（按天、按模型）；追踪窗口最近 30 天。`
          : "还没有可统计的请求 —— 日志里没有带用量的 done 事件（跑一轮对话后再看）。",
      );
    } catch (error) {
      setNote(`读取失败：${String((error as Error)?.message ?? error)}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    /* 只在进入页面时读一次；刷新按钮给"我刚跑完一轮"用 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maxDay = useMemo(() => Math.max(1, ...(usage?.byDay.map((d) => d.input + d.output) ?? [0])), [usage]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return traces.filter((t) => {
      if (onlyFailed && t.ok) return false;
      if (!q) return true;
      return [t.title, t.sessionId, t.model, t.provider, t.error ?? ""].some((x) => x.toLowerCase().includes(q));
    });
  }, [traces, query, onlyFailed]);

  return (
    <div className="wb-setpage-body" data-testid="wb-insights">
      <div className="wb-row" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <NavCollapseButton />
        <button
          type="button"
          className="wb-chip"
          data-testid="wb-insights-usage-tab"
          aria-pressed={tab === "usage"}
          onClick={() => setTab("usage")}
        >
          用量
        </button>
        <button
          type="button"
          className="wb-chip"
          data-testid="wb-insights-traces-tab"
          aria-pressed={tab === "traces"}
          onClick={() => setTab("traces")}
        >
          请求追踪
        </button>
        <button type="button" className="wb-chip" data-testid="wb-insights-refresh" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw size={14} /> {busy ? "读取中…" : "刷新"}
        </button>
      </div>
      <p className="wb-setpage-note" data-testid="wb-insights-note">
        <Activity size={14} /> {note}
      </p>

      {tab === "usage" ? (
        usage ? (
          <>
            <div className="wb-card" data-testid="wb-insights-totals" style={{ display: "flex", gap: 24, flexWrap: "wrap", padding: 12 }}>
              <span>
                轮次 <strong>{formatCount(usage.totals.turns)}</strong>
              </span>
              <span>
                输入 <strong>{formatCount(usage.totals.input)}</strong> tokens
              </span>
              <span>
                输出 <strong>{formatCount(usage.totals.output)}</strong> tokens
              </span>
              <span className="wb-card-desc">只统计成功收尾的轮（失败轮用量不完整，不混进账单口径）</span>
            </div>

            <h4>最近 90 天（按天）</h4>
            {usage.byDay.length ? (
              <ul className="wb-card" data-testid="wb-insights-byday" style={{ listStyle: "none", margin: 0, padding: 8 }}>
                {usage.byDay.map((day) => {
                  const total = day.input + day.output;
                  return (
                    <li key={day.day} className="wb-card-row" style={{ display: "grid", gridTemplateColumns: "96px 1fr auto", gap: 8 }}>
                      <span className="wb-card-label">{day.day}</span>
                      <span
                        title={`${formatCount(day.input)} in / ${formatCount(day.output)} out`}
                        style={{
                          display: "block",
                          height: 8,
                          borderRadius: 4,
                          background: "var(--accent, #4a7dff)",
                          width: `${Math.max(2, Math.round((total / maxDay) * 100))}%`,
                          alignSelf: "center",
                        }}
                      />
                      <span className="wb-card-desc">
                        {formatCount(total)} · {day.turns} 轮
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="wb-setpage-note">还没有用量记录。</p>
            )}

            <h4>按模型</h4>
            {usage.byModel.length ? (
              <table className="wb-team-usage" data-testid="wb-insights-bymodel">
                <thead>
                  <tr>
                    <th align="left">模型</th>
                    <th align="right">输入</th>
                    <th align="right">输出</th>
                    <th align="right">轮次</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byModel.map((row) => (
                    <tr key={row.model}>
                      <td>{row.model}</td>
                      <td align="right">{formatCount(row.input)}</td>
                      <td align="right">{formatCount(row.output)}</td>
                      <td align="right">{row.turns}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="wb-setpage-note">还没有按模型的用量。</p>
            )}
          </>
        ) : (
          <p className="wb-setpage-note">正在汇总…</p>
        )
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="wb-input"
              data-testid="wb-insights-query"
              placeholder="按标题 / 会话 id / 模型 / 错误筛选"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="wb-chip" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />
              只看失败
            </label>
            <span className="wb-card-desc">
              {filtered.length} / {traces.length} 轮
            </span>
          </div>
          {filtered.length ? (
            <ul className="wb-card" data-testid="wb-insights-traces" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {filtered.map((trace) => (
                <li key={`${trace.sessionId}:${trace.requestId}:${trace.at}`} className="wb-card-row" data-testid={`wb-trace-${trace.requestId}`}>
                  <span className="wb-card-label">
                    {trace.ok ? "✓" : "✗"} {trace.title || trace.sessionId}
                  </span>
                  <span className="wb-card-desc">
                    {fmtTime(trace.at)} · {trace.model || "(未记录模型)"} · {fmtMs(trace.elapsedMs)} ·{" "}
                    {formatCount(trace.input + trace.output)} tokens · {trace.toolCalls} 次工具
                    {trace.error ? ` · ${trace.error}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wb-setpage-note">{traces.length ? "筛选后没有记录。" : "还没有请求记录。"}</p>
          )}
        </>
      )}
    </div>
  );
}
