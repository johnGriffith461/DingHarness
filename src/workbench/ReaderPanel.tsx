import { useMemo, useState } from "react";
import { BookOpen, PanelLeft, Search, Star, Table2, Trash2 } from "lucide-react";
import {
  READER_LABELS,
  READER_TABS,
  extractCharts,
  findHits,
  parseOutline,
  readingStats,
} from "@shared/reader";
import { useReaderStore } from "./readerStore";
import { useTransientFlag } from "@/utils/transientNote";

/**
 * AI 阅读（`chat/read-web`，§155）。
 *
 * 文案与三个页签逐字取自 `docs/evidence-readweb.txt`（`copilot_*` 12 条）。  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 *
 * ⚠️ 本机版**不做网络抓取**（没有那个能力，也不该假装有），
 * 所以内容来源是"粘进来的文本"或"从 AI 文档送过来"。
 * 侧栏那三件事（大纲 / 页面检索 / 图表）在本地都算得准，是这一版的主体。
 */
export function ReaderPanel() {
  const text = useReaderStore((s) => s.text);
  const title = useReaderStore((s) => s.title);
  const readings = useReaderStore((s) => s.readings);
  const tab = useReaderStore((s) => s.tab);
  const sidebar = useReaderStore((s) => s.sidebar);
  const open = useReaderStore((s) => s.open);
  const save = useReaderStore((s) => s.save);
  const openReading = useReaderStore((s) => s.openReading);
  const removeReading = useReaderStore((s) => s.removeReading);
  const setTab = useReaderStore((s) => s.setTab);
  const toggleSidebar = useReaderStore((s) => s.toggleSidebar);

  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  /* 一次性提示（P91）：句柄由 hook 管（原来裸发 setTimeout，卸载后照样跑） */
  const [saved, pulseSaved] = useTransientFlag(1500);

  const outline = useMemo(() => parseOutline(text), [text]);
  const hits = useMemo(() => findHits(text, query), [text, query]);
  const charts = useMemo(() => extractCharts(text), [text]);
  const stats = useMemo(() => readingStats(text), [text]);

  const tabIcon = { outline: BookOpen, page: Search, chart: Table2 } as const;
  const tabDesc = {
    outline: READER_LABELS.descOutline,
    page: READER_LABELS.descPage,
    chart: READER_LABELS.descChart,
  } as const;

  return (
    <section className="wb-reader" data-testid="wb-reader">
      <header className="wb-reader-head">
        <span className="wb-reader-title" data-testid="wb-reader-title">
          {title || READER_LABELS.enter}
        </span>
        {text ? (
          <span className="wb-reader-stats" data-testid="wb-reader-stats">
            {stats.chars} 字 · {stats.paragraphs} 段 · {stats.headings} 个标题
          </span>
        ) : null}
        <button
          className="wb-reader-icon"
          aria-label={sidebar ? READER_LABELS.hideSidebar : READER_LABELS.showSidebar}
          title={sidebar ? READER_LABELS.hideSidebar : READER_LABELS.showSidebar}
          data-testid="wb-reader-sidebar-toggle"
          onClick={toggleSidebar}
        >
          <PanelLeft size={14} />
        </button>
        <button
          className="wb-reader-icon"
          aria-label="收进最近阅读" title="收进最近阅读"
          data-testid="wb-reader-save"
          disabled={!text.trim()}
          onClick={() => {
            void save().then(() => {
              pulseSaved();
            });
          }}
        >
          <Star size={14} />
        </button>
      </header>

      <div className="wb-reader-body">
        <div className="wb-reader-main">
          {text ? (
            <pre className="wb-reader-text" data-testid="wb-reader-text">
              {text}
            </pre>
          ) : (
            <>
              <p className="wb-reader-empty" data-testid="wb-reader-empty">
                {READER_LABELS.empty}
              </p>
              <textarea
                className="wb-reader-input"
                data-testid="wb-reader-input"
                value={draft}
                placeholder="把一段文字粘进来（支持 Markdown 标题与表格）"
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                className="wb-reader-enter"
                data-testid="wb-reader-enter"
                disabled={!draft.trim()}
                onClick={() => open(draft)}
              >
                {READER_LABELS.enter}
              </button>
            </>
          )}
        </div>

        {sidebar ? (
          <aside className="wb-reader-side" data-testid="wb-reader-side">
            <div className="wb-reader-tabs">
              {READER_TABS.map((t) => {
                const Icon = tabIcon[t];
                return (
                  <button
                    key={t}
                    className={`wb-reader-tab${tab === t ? " is-on" : ""}`}
                    data-testid={`wb-reader-tab-${t}`}
                    title={tabDesc[t]}
                    onClick={() => setTab(t)}
                  >
                    <Icon size={13} /> {READER_LABELS[t]}
                  </button>
                );
              })}
            </div>
            <p className="wb-reader-desc" data-testid="wb-reader-desc">
              {tabDesc[tab]}
            </p>

            {tab === "outline" ? (
              outline.length ? (
                <ul className="wb-reader-list" data-testid="wb-reader-outline">
                  {outline.map((o) => (
                    <li key={`${o.line}-${o.text}`} style={{ paddingLeft: (o.level - 1) * 12 }}>
                      <span className="wb-reader-line">第 {o.page} 页</span> {o.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="wb-reader-none">{READER_LABELS.noOutline}</p>
              )
            ) : null}

            {tab === "page" ? (
              <div>
                <input
                  className="wb-reader-search"
                  data-testid="wb-reader-search"
                  value={query}
                  placeholder={READER_LABELS.descPage}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query.trim() ? (
                  <ul className="wb-reader-list" data-testid="wb-reader-hits">
                    {hits.length ? (
                      hits.map((h) => (
                        <li key={`${h.line}`}>
                          <span className="wb-reader-line">第 {h.page} 页</span> {h.text}
                        </li>
                      ))
                    ) : (
                      <li className="wb-reader-none">没有找到</li>
                    )}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {tab === "chart" ? (
              charts.tables.length || charts.images ? (
                <ul className="wb-reader-list" data-testid="wb-reader-charts">
                  {charts.tables.map((t) => (
                    <li key={`t${t.line}`}>
                      <span className="wb-reader-line">第 {t.page} 页</span> 表格：{t.header.join(" / ")}（{t.rows} 行）
                    </li>
                  ))}
                  {charts.images ? <li>图片 {charts.images} 张</li> : null}
                </ul>
              ) : (
                <p className="wb-reader-none">{READER_LABELS.noChart}</p>
              )
            ) : null}

            <div className="wb-reader-recent">
              <div className="wb-reader-recent-head" data-testid="wb-reader-recent">
                {READER_LABELS.recent}
                {saved ? <em data-testid="wb-reader-saved">已收进最近阅读</em> : null}
              </div>
              {readings.length === 0 ? (
                <p className="wb-reader-none">还没有</p>
              ) : (
                readings.map((r) => (
                  <div className="wb-reader-recent-row" key={r.id}>
                    <button
                      className="wb-reader-recent-title"
                      data-testid={`wb-reader-recent-${r.id}`}
                      onClick={() => openReading(r.id)}
                    >
                      {r.title}
                    </button>
                    <button
                      className="wb-reader-icon"
                      aria-label="移除" title="移除"
                      data-testid={`wb-reader-forget-${r.id}`}
                      onClick={() => void removeReading(r.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
