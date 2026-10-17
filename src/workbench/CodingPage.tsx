import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Globe, Heart, Info, Play, Search, Sparkles } from "lucide-react";
import type { ShellBridge } from "@shared/ipc";
import {
  CODING_CATEGORIES,
  CODING_DETAIL_LABELS,
  CODING_LABELS,
  CODING_TIME_SLOTS,
  appNameOf,
  categoryOptions,
  filterApps,
  guessCategory,
  isWebApp,
  rankApps,
  remixPrompt,
  searchResultLabel,
  timeSlotLabel,
  type CodingApp,
  type CodingCategory,
} from "@shared/coding";
import { formatBytes, formatDriveTime } from "@shared/drive";
import { useWorkbenchStore } from "./store";
import { likedHere, useCodingLikes } from "./codingLikes";

/**
 * 创作广场（`chat/coding`，§159）。
 *
 * 文案与七个分类**逐字取自** `docs/evidence-coding.txt`（`coding_*` 260 条）。  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 *
 * ⚠️ **本机版做到哪一步**：那 260 条里大半是**云端功能** ——
 * 投稿审核、创作挑战赛、举报、分享链接、跨用户排行。
 * 那些**不做**（没有后端，也不该假装有）。本机版做的是**有本地含义的那一部分**：
 * 把"我产出的网页产物"当成应用，给出分类 / 搜索 / 时间范围 / 排行 / 预览 / 创作同款。
 */
export function CodingPage() {
  const [apps, setApps] = useState<CodingApp[]>([]);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CodingCategory | "all">("all");
  const [days, setDays] = useState<number>(0);
  /** 内置预览（V6-2m）：本机地址 + 一句结果提示。 */
  const [previewUrl, setPreviewUrl] = useState("http://localhost:3000");
  const [previewNote, setPreviewNote] = useState("");

  /** 正在看详情的那个应用（null = 没打开）。 */
  const [detail, setDetail] = useState<CodingApp | null>(null);
  const liked = useCodingLikes((s) => s.liked);
  const toggleLike = useCodingLikes((s) => s.toggle);
  useEffect(() => {
    void useCodingLikes.getState().load();
  }, []);
  const [now] = useState(() => Date.now());
  const setComposerDraft = useWorkbenchStore((s) => s.setComposerDraft);

  const bridge = (window as unknown as { shell?: ShellBridge }).shell;

  useEffect(() => {
    void (async () => {
      if (!bridge?.drive) {
        setNote("读不到产物目录：请用 Electron 启动应用");
        return;
      }
      try {
        const list = await bridge.drive.list();
        setApps(
          list
            .filter((x) => isWebApp(x.name))
            .map((x) => ({
              name: appNameOf(x.name),
              path: x.path,
              bytes: x.bytes,
              updatedAt: x.modifiedAt,
              category: guessCategory(appNameOf(x.name)),
            })),
        );
        setNote("");
      } catch (e) {
        setNote(`读取失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, [bridge]);

  const visible = useMemo(() => filterApps(apps, { category, query, days, now }), [apps, category, query, days, now]);
  const top = useMemo(() => rankApps(apps, 5), [apps]);

  const openApp = (app: CodingApp): void => {
    void bridge?.drive?.open(app.path);
  };
  const openPreview = async (): Promise<void> => {
    if (!bridge?.preview) {
      setPreviewNote("这一页要在桌面端打开（浏览器预览里没有内置预览窗口）。");
      return;
    }
    const got = await bridge.preview.open(previewUrl);
    setPreviewNote(got.ok ? "预览窗口已打开（登录态会保留）" : got.error);
  };
  const remix = (app: CodingApp): void => {
    // 送到主输入区（§159 的草稿交接）—— 用户在那儿按发送就开工
    setComposerDraft(remixPrompt(app));
  };

  return (
    <section className="wb-coding" data-testid="wb-coding">
      <header className="wb-coding-head">
        <h2>{CODING_LABELS.center}</h2>
        <span className="wb-coding-count" data-testid="wb-coding-result">
          {searchResultLabel(visible.length)}
        </span>
        <span className="wb-spacer" />
        <button
          className="wb-page-btn"
          data-testid="wb-coding-create"
          onClick={() => setComposerDraft("做一个网页应用：")}
        >
          <Sparkles size={13} /> {CODING_LABELS.createApp}
        </button>
      </header>

      <div className="wb-coding-tools" data-testid="wb-coding-previewbar">
        <label className="wb-coding-search">
          <Globe size={13} />
          <input
            data-testid="wb-coding-preview-url"
            value={previewUrl}
            placeholder="http://localhost:3000（只允许本机地址）"
            onChange={(e) => setPreviewUrl(e.target.value)}
          />
        </label>
        <button className="wb-page-btn" data-testid="wb-coding-preview-open" onClick={() => void openPreview()}>
          <Play size={12} /> 打开预览
        </button>
        {previewNote ? <span className="wb-card-desc">{previewNote}</span> : null}
      </div>

      <div className="wb-coding-tools">
        <label className="wb-coding-search">
          <Search size={13} />
          <input
            data-testid="wb-coding-search"
            value={query}
            placeholder={CODING_LABELS.search}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          data-testid="wb-coding-category"
          value={category}
          onChange={(e) => setCategory(e.target.value as CodingCategory | "all")}
        >
          {categoryOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select data-testid="wb-coding-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {CODING_TIME_SLOTS.map((d) => (
            <option key={d} value={d}>
              {timeSlotLabel(d)}
            </option>
          ))}
        </select>
        <span className="wb-coding-safetips" data-testid="wb-coding-safetips">
          {CODING_LABELS.safeTips}
        </span>
      </div>

      {note ? (
        <p className="wb-coding-note" data-testid="wb-coding-note">
          {note}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="wb-coding-empty" data-testid="wb-coding-empty">
          {apps.length === 0 ? "还没有网页产物 —— 让智能体做一个网页应用试试" : CODING_LABELS.searchNone}
        </p>
      ) : (
        <div className="wb-coding-grid" data-testid="wb-coding-grid">
          {visible.map((app) => (
            <article className="wb-coding-card" data-testid={`wb-coding-app-${app.name}`} key={app.path}>
              <div className="wb-coding-cover" aria-hidden />
              <div className="wb-coding-body">
                <b className="wb-coding-name">{app.name}</b>
                <span className="wb-coding-meta">
                  {app.category} · {formatBytes(app.bytes)}
                </span>
                <div className="wb-coding-actions">
                  <button
                    className="wb-coding-act"
                    data-testid={`wb-coding-preview-${app.name}`}
                    onClick={() => openApp(app)}
                  >
                    <Play size={12} /> {CODING_LABELS.preview}
                  </button>
                  <button
                    className="wb-coding-act"
                    data-testid={`wb-coding-remix-${app.name}`}
                    onClick={() => remix(app)}
                  >
                    <Sparkles size={12} /> {CODING_LABELS.remix}
                  </button>
                  {/* 「查看详情」（§180，证据 `coding_launch_page_detail`） */}
                  <button
                    className="wb-coding-act"
                    data-testid={`wb-coding-detail-${app.name}`}
                    onClick={() => setDetail(app)}
                  >
                    <Info size={12} /> {CODING_DETAIL_LABELS.detail}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/*
        「应用详情」（§180，证据 `coding_app_page_detail_tab`）。
        本机版只有"我的应用"，所以详情页展示的是**本机这套东西**的实情：
        名字、分类、大小、路径、能不能打开，以及喜欢。
      */}
      {detail ? (
        <section className="wb-coding-detail" data-testid="wb-coding-detail">
          <header className="wb-coding-detail-head">
            <span className="wb-coding-detail-tab" data-testid="wb-coding-detail-tab">
              {CODING_DETAIL_LABELS.detailTab}
            </span>
            <span className="wb-spacer" />
            <button
              className="wb-icon"
              data-testid="wb-coding-detail-close"
              title="关闭"
              onClick={() => setDetail(null)}
            >
              ×
            </button>
          </header>
          <h3 className="wb-coding-detail-name" data-testid="wb-coding-detail-name">
            {detail.name}
          </h3>
          <p className="wb-coding-detail-meta">
            {detail.category} · {formatBytes(detail.bytes)} · {formatDriveTime(detail.updatedAt, Date.now())} 更新
          </p>
          <p className="wb-coding-detail-path">{detail.path}</p>
          <div className="wb-coding-actions">
            <button
              className="wb-coding-act"
              data-testid="wb-coding-like"
              onClick={() => void toggleLike(detail.name)}
            >
              <Heart size={12} />{" "}
              {/* 喜欢 / 取消喜欢 —— 两句话都是逐字证据 */}
              {likedHere(liked, detail.name) ? CODING_DETAIL_LABELS.unlike : CODING_DETAIL_LABELS.like}
            </button>
            <button className="wb-coding-act" onClick={() => openApp(detail)}>
              <Play size={12} /> {CODING_LABELS.preview}
            </button>
            <button className="wb-coding-act" onClick={() => remix(detail)}>
              <Sparkles size={12} /> {CODING_LABELS.remix}
            </button>
          </div>
          <p className="wb-coding-detail-note" data-testid="wb-coding-like-note">
            本机版没有跨用户热度：喜欢只记在你自己这台机器上（不给假的点赞数）
          </p>
        </section>
      ) : null}

      {/* Top 排行：本机版口径写在界面上 —— 假装有热度排行比不排行更坏 */}
      <div className="wb-coding-top" data-testid="wb-coding-top">
        <h3>{CODING_LABELS.topApps}</h3>
        <p className="wb-coding-topnote" data-testid="wb-coding-top-note">
          本机版按「最近更新」排（本体的排行是多用户热度，本机只有你自己，排不出来）
        </p>
        {top.length === 0 ? (
          <p className="wb-coding-empty">还没有应用</p>
        ) : (
          <ol className="wb-coding-rank">
            {top.map((app, i) => (
              <li key={app.path}>
                <span className="wb-coding-rank-no">{i + 1}</span>
                <span className="wb-coding-rank-name">{app.name}</span>
                <span className="wb-coding-rank-cat">{app.category}</span>
                <button
                  className="wb-coding-act"
                  aria-label={CODING_LABELS.detail}
                  title={CODING_LABELS.detail}
                  data-testid={`wb-coding-open-${app.name}`}
                  onClick={() => openApp(app)}
                >
                  <ExternalLink size={12} />
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

/** 分类列表（导出给测试与以后的筛选面板用）。 */
export { CODING_CATEGORIES };
