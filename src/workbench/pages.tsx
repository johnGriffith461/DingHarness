import { useCallback, useEffect, useMemo, useState } from "react";
import type { ShellBridge } from "@shared/ipc";
import {
  countByKind,
  DRIVE_KIND_META,
  formatBytes,
  formatDriveTime,
  selectEntries,
  type DriveEntry,
  type DriveKind,
  type DriveTab,
  ORIGIN_LABEL,
} from "@shared/drive";
import { RENAME_LABELS, isTextKind, planRename } from "@shared/driveFiles";
import { DOWNLOAD_LABELS, downloadNote } from "@shared/driveOps";
import { SEARCH_LABELS, emptyLabelFor, placeholderFor, searchItems } from "@shared/search";
import { SearchHistoryStrip } from "./SearchHistoryStrip";
import { UPLOAD_HINTS } from "@shared/upload";
import { UploadPanel } from "./UploadPanel";
import { useUploadStore } from "./uploadStore";
import { useSearchHistoryStore } from "./searchHistoryStore";
import {
  deleteConfirmTitle,
  DRIVE_LABELS,
  DRIVE_SORTS,
  DRIVE_SORT_LABEL,
  DRIVE_TABS,
  DRIVE_TAB_LABEL,
  emptyTextFor,
  filterByKind,
  filterByQuery,
  kindOptions,
  sortEntries,
  storageLine,
  untitledName,
  validateDriveName,
  type DriveSort,
} from "@shared/driveOps";
import {
  Blocks,
  Check,
  ChevronDown,
  Clock,
  Cloud,
  FileText,
  FolderOpen,
  Grid3x3,
  List,
  Monitor,
  Plus,
  Search,
  Settings2,
  Smartphone,
  Sparkles,
  Upload,
} from "lucide-react";
import { ADMIN_TABS, SCHEDULED_RECOMMEND, SCHEDULED_SERVED_IDS, SCHEDULE_COMPOSER_PLACEHOLDER } from "./copy";
import { useScheduleStore } from "./scheduleStore";
import {
  FEATURED_ITEMS,
  RECOMMENDED_PLUGINS,
  SKILL_GROUPS,
  type CatalogItem,
} from "./catalog";
import { findItemIn, useLibraryStore } from "./libraryStore";
import { useReaderStore } from "./readerStore";
import { useWorkbenchStore } from "./store";
import ContextMenu, { clampMenu, type MenuItem } from "./ContextMenu";
import {
  describeNextRun,
  ENV_LABEL,
  MAX_CUSTOM_MINUTES,
  MIN_CUSTOM_MINUTES,
  REPEAT_LABEL,
  type RepeatType,
  type RunEnv,
} from "@shared/schedule";

/**
 * 工作台的四个子页面（阶段 10）。
 *
 * 布局与文案照 `.verify\tour\` 的实机截图还原（HANDOFF §25.2）；
 * **文案不自己编** —— 能对上的都从 `copy.ts`（原版 i18n 表原样取出）里取。
 */

/* ============================================================
 * 定时任务（Ctrl Shift T）
 * ============================================================ */

/**
 * 定时任务（Ctrl Shift T）。
 *
 * 两段：上面「为你推荐」**清单来自服务端**（上位 `POST /alice/job_cron/recommend/list`），
 * 本地只做 id → 文案映射（`SCHEDULED_RECOMMEND` 是 9 条超集，这个账号实收 7 条）；
 * 下面**我的定时任务**是真调度（阶段 11.6）：建了就落盘、到点真跑、跑完记历史。
 */
export function ScheduledPage() {
  const jobs = useScheduleStore((s) => s.jobs);
  const note = useScheduleStore((s) => s.note);
  const runningId = useScheduleStore((s) => s.runningId);
  const create = useScheduleStore((s) => s.create);
  const toggle = useScheduleStore((s) => s.toggle);
  const remove = useScheduleStore((s) => s.remove);
  const runNow = useScheduleStore((s) => s.runNow);
  const update = useScheduleStore((s) => s.update);
  const takeScheduleDraft = useWorkbenchStore((s) => s.takeScheduleDraft);
  const [now, setNow] = useState(() => Date.now());

  // 每 30 秒刷新"下次执行"的倒计时文案
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /*
   * 从任务页跳过来时带着草稿（顶栏 ⏰）→ 填进表单。
   * **取走即清**：不清的话下次进这个页面又会被填一遍，
   * 用户会以为"上次填的没提交"。
   */
  useEffect(() => {
    const draft = takeScheduleDraft();
    if (draft) {
      setDraft((prev) => ({ ...prev, title: draft.title, prompt: draft.prompt }));
      setEditingId(null);
    }
    // 只在进页面时取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [draft, setDraft] = useState({
    title: "",
    prompt: "",
    repeat: "daily" as RepeatType,
    env: "cloud" as RunEnv,
    customMinutes: 60,
  });
  const [formError, setFormError] = useState("");
  /**
   * 正在编辑哪个任务（null = 在新建）。
   *
   * 用同一张表单兼做新建与编辑 —— 分两张表单的话，字段一改就得改两处，
   * 迟早出现"新建能填的编辑填不了"。
   */
  const [editingId, setEditingId] = useState<string | null>(null);

  const served = SCHEDULED_RECOMMEND.filter((item) =>
    (SCHEDULED_SERVED_IDS as readonly number[]).includes(item.id),
  );

  const startEdit = (id: string) => {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    setEditingId(id);
    setFormError("");
    setDraft({
      title: job.title,
      prompt: job.prompt,
      repeat: job.repeat,
      env: job.env,
      customMinutes: job.customMinutes ?? 60,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setFormError("");
    setDraft({ ...draft, title: "", prompt: "" });
  };

  const submit = () => {
    if (editingId) {
      const error = update(editingId, draft);
      setFormError(error ?? "");
      if (!error) cancelEdit();
      return;
    }
    const error = create(draft);
    setFormError(error ?? "");
    if (!error) setDraft({ ...draft, title: "", prompt: "" });
  };

  return (
    <section className="wb-page" data-testid="wb-page-scheduled">
      <header className="wb-page-head">
        {/* 侧栏折叠：本机版还没做（参考实现里有）—— 标 disabled，不装作能用（§125/§126） */}
<button className="wb-icon" title="打开/收起左侧栏（本机版还没做折叠）" disabled>
          <List size={15} />
        </button>
        <span className="wb-page-title" />
        {note ? (
          <span className="wb-sched-note" data-testid="wb-sched-note">
            {note}
          </span>
        ) : null}
        <button
          className="wb-page-btn"
          data-testid="wb-sched-new"
          onClick={(e) => {
            // 已经在编辑时点「新建」= 放弃编辑（否则会以为点了没反应）
            e.currentTarget.blur();
            cancelEdit();
          }}
        >
          <Plus size={14} /> 新建
        </button>
      </header>

      <div className="wb-page-body">
        <div className="wb-page-label">为你推荐</div>
        <div className="wb-card-grid">
          {served.map((item) => (
            <button
              className="wb-preset"
              key={item.titleKey}
              data-testid={`wb-preset-${item.id}`}
              title={item.titleKey}
              onClick={() => setDraft({ ...draft, title: item.title, prompt: item.summary })}
            >
              <span className="wb-preset-text">
                <b>{item.title}</b>
                <em>{item.summary}</em>
              </span>
              <Plus size={16} />
            </button>
          ))}
        </div>

        {/* 新建表单：点推荐卡会自动填标题与要做的事。编辑时这张表单一并兼做编辑 */}
        <div className="wb-sched-form" data-testid="wb-sched-form">
          {editingId ? (
            /*
             * 改名字之后光看表单分不清是在编辑还是新建 —— 给一条明确的提示。
             * 少了它，用户点完「编辑」看到表单里已有内容，会以为这是上次没提交的草稿。
             */
            <div className="wb-sched-editing" data-testid="wb-sched-editing">
              ✎ 正在编辑「{draft.title || "未命名"}」 —— 保存后按新时间重新计时，执行历史保留
            </div>
          ) : null}
          <input
            className="wb-sched-input"
            placeholder="定时任务标题"
            data-testid="wb-sched-title"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <textarea
            className="wb-sched-textarea"
            placeholder="到点要做什么（会作为一条任务发给助手）"
            data-testid="wb-sched-prompt"
            rows={2}
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
          <div className="wb-sched-row">
            <label className="wb-sched-field">
              重复
              <select
                data-testid="wb-sched-repeat"
                value={draft.repeat}
                onChange={(e) => setDraft({ ...draft, repeat: e.target.value as RepeatType })}
              >
                {(Object.keys(REPEAT_LABEL) as RepeatType[]).map((key) => (
                  <option key={key} value={key}>
                    {REPEAT_LABEL[key]}
                  </option>
                ))}
              </select>
            </label>
            {draft.repeat === "custom" ? (
              <label className="wb-sched-field">
                每
                <input
                  className="wb-sched-num"
                  type="number"
                  min={MIN_CUSTOM_MINUTES}
                  max={MAX_CUSTOM_MINUTES}
                  data-testid="wb-sched-minutes"
                  value={draft.customMinutes}
                  onChange={(e) => setDraft({ ...draft, customMinutes: Number(e.target.value) })}
                />
                分钟
              </label>
            ) : null}
            <label className="wb-sched-field">
              运行在
              <select
                data-testid="wb-sched-env"
                value={draft.env}
                onChange={(e) => setDraft({ ...draft, env: e.target.value as RunEnv })}
              >
                {(Object.keys(ENV_LABEL) as RunEnv[]).map((key) => (
                  <option key={key} value={key}>
                    {ENV_LABEL[key]}
                  </option>
                ))}
              </select>
            </label>
            <span className="wb-spacer" />
            {editingId ? (
              <>
                <button className="wb-page-btn" data-testid="wb-sched-cancel" onClick={cancelEdit}>
                  取消
                </button>
                <button className="wb-page-btn wb-page-btn-primary" data-testid="wb-sched-save" onClick={submit}>
                  <Check size={13} /> 保存修改
                </button>
              </>
            ) : (
              <button className="wb-page-btn" data-testid="wb-sched-create" onClick={submit}>
                <Plus size={13} /> 创建定时任务
              </button>
            )}
          </div>
          {formError ? (
            <div className="wb-sched-error" data-testid="wb-sched-error">
              {formError}
            </div>
          ) : null}
        </div>

        <div className="wb-page-label">我的定时任务{jobs.length > 0 ? `（${jobs.length}）` : ""}</div>
        {jobs.length === 0 ? (
          <div className="wb-sched-empty" data-testid="wb-sched-empty">
            暂无定时任务。上面点一张推荐卡、或自己填标题与要做的事，就能建一个。
          </div>
        ) : (
          <div className="wb-sched-list" data-testid="wb-sched-list">
            {jobs.map((job) => (
              <div className="wb-sched-item" key={job.id} data-testid={`wb-job-${job.id}`}>
                <div className="wb-sched-item-main">
                  <b>{job.title}</b>
                  <em>{job.prompt}</em>
                  <span className="wb-sched-meta">
                    <span className={`wb-sched-status is-${job.status}`} data-testid={`wb-job-status-${job.id}`}>
                      {job.status === "running" ? "运行中" : job.status === "paused" ? "已暂停" : "已结束"}
                    </span>
                    {REPEAT_LABEL[job.repeat]}
                    {job.repeat === "custom" ? ` ${job.customMinutes} 分钟` : ""}
                    <span className="wb-sched-dot">·</span>
                    {ENV_LABEL[job.env]}
                    <span className="wb-sched-dot">·</span>
                    <span data-testid={`wb-job-next-${job.id}`}>{describeNextRun(job.nextRunAt, now)}</span>
                    {job.runs.length > 0 ? (
                      <>
                        <span className="wb-sched-dot">·</span>
                        已执行 {job.runs.length} 次
                        {job.runs[0].ok ? "" : `（上次失败：${job.runs[0].error ?? "未知"}）`}
                      </>
                    ) : null}
                  </span>
                </div>
                <div className="wb-sched-item-actions">
                  <button
                    className="wb-icon"
                    title="立刻执行一次"
                    data-testid={`wb-job-run-${job.id}`}
                    disabled={runningId !== null}
                    onClick={() => void runNow(job.id)}
                  >
                    {runningId === job.id ? "…" : "▶"}
                  </button>
                  <button
                    className="wb-icon"
                    title={job.status === "running" ? "暂停" : "继续"}
                    data-testid={`wb-job-toggle-${job.id}`}
                    onClick={() => toggle(job.id)}
                  >
                    {job.status === "running" ? "⏸" : "▶︎"}
                  </button>
                  <button
                    className="wb-icon"
                    title="编辑（改名字 / 改时间 / 改内容）"
                    data-testid={`wb-job-edit-${job.id}`}
                    onClick={() => startEdit(job.id)}
                  >
                    ✎
                  </button>
                  <button
                    className="wb-icon"
                    title="删除"
                    data-testid={`wb-job-del-${job.id}`}
                    onClick={() => {
                      // 删掉的正好是在编辑的那个 → 退出编辑，否则表单会对着一个不存在的任务提交
                      if (editingId === job.id) cancelEdit();
                      remove(job.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="wb-cloud-foot">
          定时任务存在本机，关掉窗口后不会执行；下次打开会顺延到下一个周期（不补跑错过的）
        </div>
      </div>

      <div className="wb-composer wb-composer-slim">
        <div className="wb-composer-input wb-composer-placeholder">{SCHEDULE_COMPOSER_PLACEHOLDER}</div>
        <div className="wb-composer-bar">
          <button className="wb-icon">
            <Plus size={16} />
          </button>
          <button className="wb-chip">
            <Cloud size={13} /> 云电脑 <ChevronDown size={12} />
          </button>
          <button className="wb-chip">
            <FolderOpen size={13} /> 项目
          </button>
          <button className="wb-chip">
            <Sparkles size={13} /> 技能
          </button>
          <button className="wb-chip">
            <Blocks size={13} /> 插件
          </button>
          <span className="wb-spacer" />
          <button className="wb-chip">
            自动 <ChevronDown size={12} /> 低
          </button>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
 * 插件·技能·伙伴（Ctrl Shift S）
 * ============================================================ */

const PLUGIN_CATEGORIES = [
  "精选",
  "办公",
  "金融",
  "财税支付",
  "多媒体创作",
  "内容创作",
  "营销销售",
  "电商",
  "企业管理",
  "效率工具",
  "数据分析",
] as const;

export function PluginsPage() {
  const [tab, setTab] = useState<(typeof ADMIN_TABS)[number]>("插件");
  const [category, setCategory] = useState<string>("精选");
  const installed = useLibraryStore((s) => s.lib.installed);
  const enabled = useLibraryStore((s) => s.lib.enabled);
  const install = useLibraryStore((s) => s.install);
  const enable = useLibraryStore((s) => s.enable);

  /** 市场 / 管理 两级（实机是子页，不是弹窗）。 */
  const [mode, setMode] = useState<"market" | "manage">("market");
  /* 技能搜索（§160）：`search_skills_input_placeholder` = 搜索技能 */
  const [skillQuery, setSkillQuery] = useState("");
  const recordSearch = useSearchHistoryStore((s) => s.record);
  /** 什么时候算"搜过一次"：按回车、或离开输入框时（**不是每敲一个字都记**）。 */
  const commitSkillQuery = (): void => {
    if (skillQuery.trim()) recordSearch("skills", skillQuery);
  };
  /** 管理页的三 tab：插件 / 技能 / **连接器**（与市场页的「工作伙伴」不同）。 */
  const [manageTab, setManageTab] = useState<"插件" | "技能" | "连接器">("插件");

  /*
   * 「添加」本机版的诚实对应物：**自己写一条能力**。
   * 本机版没有插件市场后端，所以让能力清单可扩展的路子是"用户自己写"，
   * 而不是假装能装一个远端插件。
   */
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addHint, setAddHint] = useState("");
  const [addType, setAddType] = useState<"plugin" | "skill">("skill");
  const [addError, setAddError] = useState("");
  const addCustomItem = useLibraryStore((s) => s.addCustomItem);
  const lib = useLibraryStore((s) => s.lib);

  /*
   * 技能搜索（§160）：**先按匹配程度排，再丢掉空分组** ——
   * 留着空分组会让人以为"这个分类里什么都没有"，而不是"这一搜什么都没有"。
   */
  const filteredSkillGroups = SKILL_GROUPS.map(({ group, items }) => ({
    group,
    items: searchItems(items, skillQuery, (i) => i.name),
  })).filter((g) => g.items.length > 0);
  const skillEmpty = tab === "技能" && filteredSkillGroups.length === 0;

  const installedSet = new Set(installed);
  const enabledSet = new Set(enabled);
  /*
   * 必须用 `findItemIn` 而不是 `findItem`：自定义条目不在内置目录里，
   * 只查目录的话它们在这一页**看不见、计数也不对** ——
   * 同一个查询在"输入区"和"这一页"两处各写一遍，就会出现这种一半对一半错
   * （§49 与 §43 都是同一类）。所以两处都用同一个函数。
   */
  const installedItems = installed
    .map((id) => {
      const found = findItemIn(lib, id);
      if (!found) return null;
      return {
        id,
        name: found.name,
        hint: found.hint,
        type: found.type,
        // 目录条目有使用量，自己加的没有 —— 如实写"手动添加"，不编一个数
        users: (found as Partial<CatalogItem>).users ?? "手动添加",
      };
    })
    .filter((x): x is { id: string; name: string; hint: string; type: "plugin" | "skill"; users: string } =>
      Boolean(x),
    );
  const manageCounts = {
    插件: installedItems.filter((i) => i.type === "plugin").length,
    技能: installedItems.filter((i) => i.type === "skill").length,
    连接器: 0,
  };

  if (mode === "manage") {
    const listed = installedItems.filter((item) =>
      manageTab === "连接器" ? false : manageTab === "技能" ? item.type === "skill" : item.type === "plugin",
    );
    return (
      <section className="wb-page" data-testid="wb-page-plugins-manage">
        <header className="wb-page-head">
          <span className="wb-crumb">
            <button className="wb-crumb-link" data-testid="wb-crumb-market" onClick={() => setMode("market")}>
              市场
            </button>
            <span className="wb-crumb-sep">›</span>
            <b>管理</b>
          </span>
          <span className="wb-spacer" />
          <div className="wb-search">
            <Search size={13} />
            <span>搜索{manageTab}</span>
          </div>
          <button className="wb-page-btn" data-testid="wb-manage-add" onClick={() => setMode("market")}>
            <Plus size={14} /> 添加
          </button>
          {/*
            刷新：原来是个**没有 onClick 的死按钮**（§124 审计报出）。
            这里用 store 的 getState() 直接调 —— 不必为一个按钮改这个组件的解构。
          */}
          <button
            className="wb-icon"
            title="刷新"
            data-testid="wb-manage-refresh"
            onClick={() => void useLibraryStore.getState().load()}
          >
            ⟳
          </button>
        </header>

        <div className="wb-page-body">
          <div className="wb-tabs wb-manage-tabs" data-testid="wb-manage-tabs">
            {(["插件", "技能", "连接器"] as const).map((t) => (
              <button
                key={t}
                className={`wb-tab wb-manage-tab${manageTab === t ? " is-on" : ""}`}
                data-testid={`wb-manage-tab-${t}`}
                onClick={() => setManageTab(t)}
              >
                {t} <em>{manageCounts[t]}</em>
              </button>
            ))}
          </div>

          {listed.length === 0 ? (
            <div className="wb-manage-empty" data-testid="wb-manage-empty">
              {manageTab === "连接器" ? "还没有添加连接器（本机版不含连接器体系）" : `你还没有添加${manageTab}`}
            </div>
          ) : (
            <div className="wb-sched-list">
              {listed.map((item) => (
                <div className="wb-sched-item" key={item.id} data-testid={`wb-managed-${item.id}`}>
                  <div className="wb-sched-item-main">
                    <b>{item.name}</b>
                    <em>{item.hint}</em>
                    <span className="wb-sched-meta">
                      {item.users}
                      {enabledSet.has(item.id) ? " · 已启用" : ""}
                    </span>
                  </div>
                  <button className="wb-page-btn" data-testid={`wb-remove-${item.id}`} onClick={() => install(item.id)}>
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="wb-page" data-testid="wb-page-plugins">
      <header className="wb-page-head">
        {/* 侧栏折叠：本机版还没做（参考实现里有）—— 标 disabled，不装作能用（§125/§126） */}
<button className="wb-icon" title="打开/收起左侧栏（本机版还没做折叠）" disabled>
          <List size={15} />
        </button>
        <div className="wb-tabs" data-testid="wb-plugin-tabs">
          {ADMIN_TABS.map((t) => (
            <button
              key={t}
              className={`wb-tab${tab === t ? " is-on" : ""}`}
              data-testid={`wb-plugin-tab-${t}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="wb-spacer" />
        <span className="wb-cloud-count" data-testid="wb-installed-count">
          已安装 {installed.length} 个
          {enabled.length > 0 ? ` · 启用 ${enabled.length} 个` : ""}
        </span>
        <div className="wb-search">
          <Search size={13} />
          <span>搜索{tab}</span>
        </div>
        <button
          className="wb-page-btn"
          data-testid="wb-plugin-manage"
          onClick={() => {
            /*
             * 进「管理」时**回到默认 tab**。
             * 不重置的话会记住上次停在哪个 tab —— 如果上次停在「连接器」，
             * 而本机版没有连接器体系，用户一进来看到的就是一个空页，像坏了。
             */
            setManageTab("插件");
            setMode("manage");
          }}
        >
          <Settings2 size={13} /> 管理
        </button>
        <button
          className="wb-page-btn"
          data-testid="wb-plugin-add"
          onClick={() => {
            setAddOpen((v) => !v);
            setAddError("");
          }}
        >
          <Plus size={14} /> 添加
        </button>
      </header>

      <div className="wb-page-body">
        <label className="wb-searchbox" data-testid="wb-plugin-searchbox">
          <Search size={13} />
          <input
            data-testid="wb-plugins-search"
            value={skillQuery}
            placeholder={placeholderFor("skills")}
            onChange={(e) => setSkillQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSkillQuery();
            }}
            onBlur={commitSkillQuery}
          />
        </label>
        {skillQuery ? null : <SearchHistoryStrip scope="skills" onPick={setSkillQuery} />}
        <div className="wb-chips" data-testid="wb-plugin-categories">
          {PLUGIN_CATEGORIES.map((c) => (
            <button key={c} className={`wb-cat${category === c ? " is-on" : ""}`} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
          <button className="wb-cat">
            更多 <ChevronDown size={12} />
          </button>
        </div>

        {tab === "技能" ? (
          <>
            {filteredSkillGroups.map(({ group, items }) => (
              <div key={group}>
                <div className="wb-group-title">
                  {group} <ChevronRight />
                </div>
                <div className="wb-plugin-grid">
                  {items.map((item) => (
                    <PluginCard
                      key={item.id}
                      item={item}
                      installed={installedSet.has(item.id)}
                      enabled={enabledSet.has(item.id)}
                      onInstall={() => install(item.id)}
                      onEnable={() => enable(item.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
            {/*
              搜不到时说清"是这一搜没有"（`search_skills_empty_info` = 无匹配的技能），
              而不是留一片空白让人以为页面坏了。
            */}
            {skillEmpty ? (
              <p className="wb-search-empty" data-testid="wb-plugins-empty">
                {SEARCH_LABELS.skillsEmpty}
              </p>
            ) : null}
          </>
        ) : (
          <>
        {addOpen ? (
          <div className="wb-addform" data-testid="wb-add-form">
            <div className="wb-addform-row">
              <select
                className="wb-sched-select"
                data-testid="wb-add-type"
                value={addType}
                onChange={(e) => setAddType(e.target.value as "plugin" | "skill")}
              >
                <option value="skill">技能</option>
                <option value="plugin">插件</option>
              </select>
              <input
                className="wb-sched-input"
                placeholder="名字"
                data-testid="wb-add-name"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
              />
            </div>
            <input
              className="wb-sched-input"
              placeholder="一句话说明它干什么 —— 这句会进任务的提示词，写清楚点"
              data-testid="wb-add-hint"
              value={addHint}
              onChange={(e) => setAddHint(e.target.value)}
            />
            <div className="wb-addform-foot">
              {addError ? (
                <em className="wb-addform-err" data-testid="wb-add-error">
                  {addError}
                </em>
              ) : (
                <em className="wb-addform-tip">加完会自动装上并启用，可直接在任务里用</em>
              )}
              <span className="wb-spacer" />
              <button className="wb-page-btn" data-testid="wb-add-cancel" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button
                className="wb-page-btn wb-page-btn-primary"
                data-testid="wb-add-save"
                onClick={() => {
                  const error = addCustomItem(addName, addHint, addType);
                  setAddError(error ?? "");
                  if (!error) {
                    setAddName("");
                    setAddHint("");
                    setAddOpen(false);
                  }
                }}
              >
                <Check size={13} /> 添加并启用
              </button>
            </div>
          </div>
        ) : null}

            <div className="wb-featured">
              {FEATURED_ITEMS.map((item) => (
                <div className="wb-feature-card" key={item.id}>
                  <span className="wb-feature-text">
                    <em>必备精选</em>
                    <b>{item.name}</b>
                    <span>{item.hint}</span>
                  </span>
                  <span className="wb-feature-art" />
                  <button
                    className={`wb-install${installedSet.has(item.id) ? " is-done" : ""}`}
                    data-testid={`wb-install-${item.id}`}
                    onClick={() => install(item.id)}
                  >
                    {installedSet.has(item.id) ? "已安装" : "安装"}
                  </button>
                </div>
              ))}
            </div>

            <div className="wb-page-label">特别推荐</div>
            <div className="wb-plugin-grid">
              {RECOMMENDED_PLUGINS.map((item) => (
                <PluginCard
                  key={item.id}
                  item={item}
                  installed={installedSet.has(item.id)}
                  enabled={enabledSet.has(item.id)}
                  onInstall={() => install(item.id)}
                  onEnable={() => enable(item.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function ChevronRight() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/**
 * 一个插件/技能条目。
 *
 * 两个按钮的含义是分开的：**安装**是把条目拿到本机，**启用**是这次任务里要不要用它。
 * 不分开的话，"装了但这次不想用"就没法表达。
 */
function PluginCard({
  item,
  installed,
  enabled,
  onInstall,
  onEnable,
}: {
  item: CatalogItem;
  installed: boolean;
  enabled: boolean;
  onInstall: () => void;
  onEnable: () => void;
}) {
  return (
    <div className="wb-plugin" data-testid={`wb-plugin-${item.id}`}>
      <span className="wb-plugin-icon" />
      <span className="wb-plugin-text">
        <b>{item.name}</b>
        <em>{item.hint}</em>
        <span className="wb-plugin-users">{item.users}</span>
      </span>
      {installed ? (
        <button
          className={`wb-install${enabled ? " is-enabled" : ""}`}
          title={enabled ? "这次任务会用它" : "装了但这次不用"}
          data-testid={`wb-enable-${item.id}`}
          onClick={onEnable}
        >
          {enabled ? "已启用" : "启用"}
        </button>
      ) : null}
      <button
        className={`wb-install${installed ? " is-done" : ""}`}
        data-testid={`wb-install-${item.id}`}
        onClick={onInstall}
      >
        {installed ? "卸载" : "安装"}
      </button>
    </div>
  );
}

/* ============================================================
 * 云盘（Ctrl Shift D）
 * ============================================================ */

/**
 * 云盘文件行的右键菜单（对标实机 `04-cloud-row-context.png`）。
 *
 * 实机的七项：问问豆包 / 分享 / 复制链接 / 创建副本 / 添加快捷方式到 › / 收藏 / 删除。
 * 这里**能做的就真做，做不了的写清为什么** —— 分享与快捷方式需要服务端/系统集成，
 * 硬凑一个点了没反应的项比不放更糟。
 */
function DriveRowMenu({
  entry,
  x,
  y,
  starred,
  onClose,
  onChanged,
  onAiReading,
  onRename,
  onDelete,
  onDownload,
}: {
  entry: DriveEntry;
  x: number;
  y: number;
  starred: boolean;
  onClose: () => void;
  onChanged: (note: string) => void;
  /** 送到 AI 阅读（§158，证据里的 `drive_menuOption_AIReading`）。 */
  onAiReading: (entry: DriveEntry) => void;
  /** 改名（`drive_menuOption_rename`）。 */
  onRename: (entry: DriveEntry) => void;
  /** 删除（**要走确认框**，`drive_confirm_title_deleteFile`）。 */
  onDelete: (entry: DriveEntry) => void;
  /** 下载 / 另存为（§169）。 */
  onDownload: (entry: DriveEntry) => void;
}) {
  const openFloat = useWorkbenchStore((s) => s.openFloat);
  const star = useLibraryStore((s) => s.star);
  const bridge = (window as unknown as { shell?: ShellBridge }).shell;

  const items: MenuItem[] = [
    {
      label: "问问豆包",
      icon: "💬",
      run: () => openFloat(`读一下这个文件：${entry.path}\n然后用一句话说清它讲了什么。`),
    },
    {
      /* 「AI 阅读」：把文件读成文本送进阅读面板 —— 真接上的（大纲/页面检索/图表都能用，§155） */
      label: "AI 阅读",
      icon: "📖",
      run: () => onAiReading(entry),
    },
    {
      /* 「下载」（§169）：给了目标目录就静默复制，不给就弹系统"另存为"框 */
      label: "下载",
      icon: "⬇",
      run: () => onDownload(entry),
    },
    {
      label: "重命名",
      icon: "✏️",
      run: () => onRename(entry),
    },
    { label: "分享", icon: "↗", disabled: "分享需要服务端支持，本机版没有" },
    {
      label: "复制链接",
      icon: "🔗",
      run: () => {
        void navigator.clipboard.writeText(`dshasset://file/${entry.origin}/${encodeURIComponent(entry.name)}`);
        onChanged("已复制链接");
      },
    },
    {
      label: "创建副本",
      icon: "⧉",
      run: () => {
        void bridge?.drive
          ?.duplicate(entry.path)
          .then((name) => onChanged(name ? `已创建副本：${name}` : "创建副本失败"));
      },
    },
    { label: "添加快捷方式到", icon: "⊞", disabled: "需要系统级快捷方式支持，本机版没有" },
    {
      label: starred ? "取消收藏" : "收藏",
      icon: "☆",
      run: () => star(entry.name),
    },
    {
      // 删除**必须走确认**（证据 `drive_confirm_title_deleteFile`）—— 删文件是不可逆的
      label: "删除",
      icon: "🗑",
      run: () => onDelete(entry),
    },
  ];

  return <ContextMenu items={items} x={x} y={y} onClose={onClose} testid="wb-drive-menu" />;
}
/**
 * 云盘（Ctrl Shift D）。
 *
 * **接真实目录**（阶段 11.5）：产物 / 画布导出 / 云盘本体三个来源，
 * 列表里每一条都是磁盘上真有的文件。原来那 10 行是遍历原版时的截图内容 ——
 * 等于把「当时看到的东西」当成了实现，换个账号一行都不对。
 *
 * 列口径说明：上位是 `标题 / 所有者 / 创建时间 / 最近访问`，
 * 这里是**单机版**、没有多用户，所以把「所有者」换成更有用的「类型 / 大小」。
 * 这是有意分歧，不是漏做。
 */
export function CloudPage() {
  const [tab, setTab] = useState<DriveTab>("recent");
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [grid, setGrid] = useState(false);
  /*
   * 收藏统一放在本机库（`library.json`）里，不再单独用 localStorage。
   * 原来那条 `dsh-canvas.drive-starred` 是第二份状态 —— 两份状态迟早对不上。
   */
  const starredList = useLibraryStore((s) => s.lib.starredFiles);
  const star = useLibraryStore((s) => s.star);
  const starred = useMemo(() => new Set(starredList), [starredList]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  /**
   * 正在往云盘上拖东西（§171）。
   *
   * ⚠️ `dragleave` 在拖过子元素时也会触发 —— 只看它会让高亮乱闪。
   * 这里用"计数"的办法：进来 +1、出去 -1，归零才算真的离开。
   */
  const [dragDepth, setDragDepth] = useState(0);

  /** 一次拖拽的收尾动作（`importData` 那条路，内容导入）。 */
  const onDropFiles = (files: File[]) => {
    setDragDepth(0);
    if (files.length === 0) return;
    void (async () => {
      await useUploadStore.getState().startFiles(files);
      await refresh();
    })();
  };
  const [now] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const bridge = (window as unknown as { shell?: ShellBridge }).shell;
    if (!bridge?.drive) {
      setNote("云盘通道不可用：请用 Electron 启动应用");
      return;
    }
    setBusy(true);
    try {
      const list = await bridge.drive.list();
      // 主进程给的是字符串型 kind，这里收窄成联合类型（两边共用同一套枚举）
      setEntries(list as DriveEntry[]);
      setNote("");
    } catch (error) {
      setNote(`读取云盘失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* 筛选与排序（§157）：本体是「筛选（所有类型）」+「自定义排序（正序/倒序）」两个控件 */
  const [kindFilter, setKindFilter] = useState<DriveKind | "all">("all");
  const [sortKey, setSortKey] = useState<DriveSort | null>(null);
  const [desc, setDesc] = useState(false);
  /* 新建：本体是一个菜单（新建文档 / 新建文件夹 / 新建 PPT） */
  const [newMenu, setNewMenu] = useState(false);

  /* 云盘搜索（§160）：`drive_searchWindow_placeholder` = 搜索文件 */
  const [fileQuery, setFileQuery] = useState("");
  const recordSearch = useSearchHistoryStore((s) => s.record);
  const commitFileQuery = (): void => {
    if (fileQuery.trim()) recordSearch("files", fileQuery);
  };
  /* 删除确认与重命名（§158）：两个都要对话框，删文件不可逆、改名会影响引用 */
  const [confirmDel, setConfirmDel] = useState<DriveEntry | null>(null);
  const [renameOf, setRenameOf] = useState<DriveEntry | null>(null);
  const [renameText, setRenameText] = useState("");
  const [renameError, setRenameError] = useState("");

  /*
   * 列表流水线（§157）：**标签页 → 筛选 → 排序**，三步都是纯函数。
   * 顺序不能换：先按标签页取集合，再筛类目，最后排序 ——
   * 反过来的话，"最近"里的排序会被筛选打乱。
   */
  const visible = useMemo(() => {
    const byTab = selectEntries(entries, tab, starred);
    const kept = filterByKind(filterByQuery(byTab, fileQuery), kindFilter);
    // 没手动选排序时，用标签页自己的口径（selectEntries 已经排好了）
    return sortKey ? sortEntries(kept, sortKey, desc) : kept;
  }, [entries, tab, starred, kindFilter, sortKey, desc, fileQuery]);
  const counts = useMemo(() => countByKind(entries), [entries]);

  const toggleStar = (name: string) => star(name);

  /* 右键菜单：记下坐标与目标行 */
  const [menu, setMenu] = useState<{ entry: DriveEntry; x: number; y: number } | null>(null);

  const bridge = (window as unknown as { shell?: ShellBridge }).shell;

  return (
    <section className="wb-page" data-testid="wb-page-cloud">
      <header className="wb-page-head">
        {/* 侧栏折叠：本机版还没做（参考实现里有）—— 标 disabled，不装作能用（§125/§126） */}
<button className="wb-icon" title="打开/收起左侧栏（本机版还没做折叠）" disabled>
          <List size={15} />
        </button>
        <div className="wb-tabs">
          {(
            // 证据里的四个 + 本机版的「收藏」（只增不减，§157）
            [...DRIVE_TABS, "starred" as const].map((id) => [id, DRIVE_TAB_LABEL[id]] as const)
          ).map(([id, label]) => (
            <button
              key={id}
              className={`wb-tab${tab === id ? " is-on" : ""}`}
              data-testid={`wb-cloud-tab-${id}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="wb-spacer" />
        <span className="wb-cloud-count" data-testid="wb-cloud-count">
          {entries.length} 个文件
          {Object.keys(counts).length > 0
            ? `（${Object.entries(counts)
                .map(([k, v]) => `${DRIVE_KIND_META[k as DriveKind]?.label ?? k} ${v}`)
                .join(" / ")}）`
            : ""}
        </span>
        <button className="wb-icon" title="刷新" data-testid="wb-cloud-refresh" onClick={() => void refresh()}>
          {busy ? "…" : "⟳"}
        </button>
        <button
          className="wb-page-btn"
          data-testid="wb-cloud-upload"
          /*
           * 「上传」走 uploadStore（§170）：它先把任务摆成"正在上传"，
           * 拿到**按文件**的结果之后再逐条落成已完成 / 失败 —— 这样才有状态面板可看。
           */
          onClick={() => {
            void (async () => {
              await useUploadStore.getState().startDialog();
              await refresh();
            })();
          }}
        >
          <Upload size={13} /> 上传
        </button>        <div className="wb-cloud-newbox">
          <button
            className="wb-page-btn"
            data-testid="wb-cloud-new"
            onClick={() => setNewMenu((v) => !v)}
          >
            <Plus size={14} /> {DRIVE_LABELS.addNew}
          </button>
          {newMenu ? (
            <div className="wb-cloud-newmenu" data-testid="wb-cloud-newmenu">
              {(
                [
                  ["doc", DRIVE_LABELS.newDoc],
                  ["folder", DRIVE_LABELS.newFolder],
                  ["slides", DRIVE_LABELS.newSlides],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  className="wb-cloud-newmenu-item"
                  data-testid={`wb-cloud-new-${kind}`}
                  onClick={() => {
                    setNewMenu(false);
                    void (async () => {
                      if (!bridge?.drive) return;
                      const names = entries.map((x) => x.name);
                      /*
                       * 名字用一个输入框问（本体是个正经的命名弹窗 `drive_newFolder_header`
                       * + `请输入文件夹名称`；本机版先用 prompt 顶着，类型选择走上面的菜单）。
                       * 默认名由 `untitledName` 给 —— 重名加序号，**绝不覆盖**。
                       */
                      const raw = window.prompt(
                        kind === "folder" ? DRIVE_LABELS.folderNamePlaceholder : "新建文件",
                        untitledName(kind, names),
                      );
                      if (raw === null) return;
                      const name = raw.trim() || untitledName(kind, names);
                      const verdict = validateDriveName(name);
                      if (verdict) {
                        setNote(verdict);
                        return;
                      }
                      if (kind === "folder") {
                        const made = await bridge.drive.mkdir(name);
                        setNote(made ? `已新建 ${made}` : "新建文件夹失败（可能已存在）");
                      } else {
                        const body =
                          kind === "slides"
                            ? `# ${name.replace(/\.md$/i, "")}\n\n## 第一页\n\n## 第二页\n`
                            : `# ${name.replace(/\.md$/i, "")}\n\n`;
                        const made = await bridge.drive.create(name, body);
                        setNote(made ? `已新建 ${made}` : "新建失败（名字里不能有路径分隔符）");
                      }
                      await refresh();
                    })();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      <div className="wb-page-body wb-page-flush">
        {/* 上传任务面板（§170）：没有任务时它自己不显示 */}
        <UploadPanel />

        {/*
          拖拽上传（§171）：整页接管拖放 —— 拖到哪儿都算数，不用瞄准一个小框。
          ⚠️ 文案不编新词：证据里没有"拖进来/松开"这类话，
          所以角标上用已有的 `drive_upload_file`（上传文件）。
        */}
        <div
          className={dragDepth > 0 ? "wb-cloud-drop is-over" : "wb-cloud-drop"}
          data-testid="wb-cloud-drop"
          onDragEnter={(e) => {
            e.preventDefault();
            setDragDepth((d) => d + 1);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
          onDrop={(e) => {
            e.preventDefault();
            onDropFiles(Array.from(e.dataTransfer?.files ?? []));
          }}
        >
          {dragDepth > 0 ? <span className="wb-cloud-drop-hint">{UPLOAD_HINTS.file}</span> : null}
        </div>

        <div className="wb-cloud-tools">
          <span className="wb-spacer" />
          {note ? (
            <span className="wb-cloud-note" data-testid="wb-cloud-note">
              {note}
            </span>
          ) : null}
          <label className="wb-searchbox" data-testid="wb-cloud-searchbox">
            <Search size={13} />
            <input
              data-testid="wb-cloud-search"
              value={fileQuery}
              placeholder={placeholderFor("files")}
              onChange={(e) => setFileQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitFileQuery();
              }}
              onBlur={commitFileQuery}
            />
          </label>
          {fileQuery ? null : <SearchHistoryStrip scope="files" onPick={setFileQuery} />}
          <label className="wb-cloud-filter" title={DRIVE_LABELS.filter}>
            <select
              data-testid="wb-cloud-filter"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as DriveKind | "all")}
            >
              {kindOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wb-cloud-filter" title={DRIVE_LABELS.customSort}>
            <select
              data-testid="wb-cloud-sort"
              value={sortKey ?? ""}
              onChange={(e) => setSortKey((e.target.value || null) as DriveSort | null)}
            >
              <option value="">{DRIVE_LABELS.customSort}</option>
              {DRIVE_SORTS.map((k) => (
                <option key={k} value={k}>
                  {DRIVE_SORT_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <button
            className="wb-icon"
            title={desc ? DRIVE_LABELS.ascend : DRIVE_LABELS.descend}
            data-testid="wb-cloud-sort-dir"
            onClick={() => setDesc((v) => !v)}
          >
            {desc ? "↓" : "↑"}
          </button>
          <button className={`wb-icon${grid ? "" : " is-on"}`} onClick={() => setGrid(false)} title="列表">
            <List size={14} />
          </button>
          <button className={`wb-icon${grid ? " is-on" : ""}`} onClick={() => setGrid(true)} title="网格">
            <Grid3x3 size={14} />
          </button>
        </div>

        {visible.length === 0 ? (
          <div className="wb-cloud-empty" data-testid="wb-cloud-empty">
            {tab === "starred"
              ? "还没有收藏的文件（点文件名旁的 ☆ 收藏）"
              : entries.length === 0
                ? emptyTextFor(kindFilter)
                : /* 有搜索结果这一说的时候，说清"是这一搜没有"（`drive_searchWindow_result_empty`） */
                  emptyLabelFor("files", visible.length) || "这个筛选下没有文件"}
          </div>
        ) : (
          <div className={`wb-table${grid ? " is-grid" : ""}`} data-testid="wb-cloud-table">
            <div className="wb-tr wb-th">
              <span>名称</span>
              <span>文件类型</span>
              <span>文件大小</span>
              <span>创建时间</span>
              <span>最近修改</span>
              <span />
            </div>
            {visible.map((entry) => (
              <div
                className="wb-tr"
                key={entry.path}
                data-testid={`wb-file-${entry.name}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // 菜单靠右下角时会跑出窗口，夹一下
                  setMenu({ entry, ...clampMenu(e.clientX, e.clientY) });
                }}
              >
                <span className="wb-td-name">
                  <FileText size={14} />
                  <button
                    className="wb-td-link"
                    title={entry.path}
                    data-testid={`wb-open-${entry.name}`}
                    onClick={async () => {
                      if (!bridge?.drive) return;
                      const error = await bridge.drive.open(entry.path);
                      if (error) setNote(`打不开：${error}`);
                    }}
                  >
                    {entry.name}
                  </button>
                  {/* 来源标签走一处映射：加一个来源不必再回来改这里（§166） */}
                  {ORIGIN_LABEL[entry.origin] ? (
                    <em className="wb-td-from">{ORIGIN_LABEL[entry.origin]}</em>
                  ) : null}
                </span>
                <span>
                  <span className={`wb-kind ${DRIVE_KIND_META[entry.kind].tone}`}>
                    {DRIVE_KIND_META[entry.kind].label}
                  </span>
                </span>
                <span className="wb-td-num">{formatBytes(entry.bytes)}</span>
                <span>{formatDriveTime(entry.createdAt, now)}</span>
                <span>{formatDriveTime(entry.modifiedAt, now)}</span>
                <span className="wb-td-more">
                  <button
                    className="wb-icon"
                    title={starred.has(entry.name) ? "取消收藏" : "收藏"}
                    data-testid={`wb-star-${entry.name}`}
                    onClick={() => toggleStar(entry.name)}
                  >
                    {starred.has(entry.name) ? "★" : "☆"}
                  </button>
                  <button
                    className="wb-icon"
                    title="在文件夹里定位"
                    onClick={() => void bridge?.drive?.reveal(entry.path)}
                  >
                    <FolderOpen size={12} />
                  </button>
                  <button
                    className="wb-icon"
                    title="从云盘删除"
                    data-testid={`wb-del-${entry.name}`}
                    onClick={() => setConfirmDel(entry)}
                  >
                    ×
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 到底了（`drive_page_end`）+ 已使用多少（`drive_storage_used`） */}
        {visible.length > 0 ? (
          <div className="wb-cloud-end" data-testid="wb-cloud-page-end">
            已经到底了
          </div>
        ) : null}
        <div className="wb-cloud-foot">
          <span data-testid="wb-cloud-storage">
            {storageLine(
              entries.reduce((sum, x) => sum + x.bytes, 0),
              formatBytes,
            )}
          </span>
          <span className="wb-spacer" />
          使用云盘，代表你已阅读并同意 云盘使用须知
        </div>
      </div>

      {confirmDel ? (
        <div className="wb-cloud-dialog" data-testid="wb-cloud-confirm">
          <p data-testid="wb-cloud-confirm-title">{deleteConfirmTitle(confirmDel)}</p>
          <p className="wb-cloud-dialog-sub">{confirmDel.name}</p>
          <div className="wb-cloud-dialog-bar">
            <button
              className="wb-agent-cancel"
              data-testid="wb-cloud-confirm-cancel"
              onClick={() => setConfirmDel(null)}
            >
              取消
            </button>
            <button
              className="wb-agent-start"
              data-testid="wb-cloud-confirm-ok"
              onClick={() => {
                const target = confirmDel;
                setConfirmDel(null);
                void (async () => {
                  if (!bridge?.drive) return;
                  const ok = await bridge.drive.remove(target.path);
                  setNote(ok ? `已删除 ${target.name}` : "删除失败");
                  if (ok) await refresh();
                })();
              }}
            >
              删除
            </button>
          </div>
        </div>
      ) : null}

      {renameOf ? (
        <div className="wb-cloud-dialog" data-testid="wb-cloud-rename">
          <p>{RENAME_LABELS.title}</p>
          <input
            className="wb-cloud-dialog-input"
            data-testid="wb-cloud-rename-input"
            value={renameText}
            placeholder={RENAME_LABELS.title}
            onChange={(e) => {
              setRenameText(e.target.value);
              setRenameError("");
            }}
          />
          {renameError ? (
            <p className="wb-cloud-dialog-err" data-testid="wb-cloud-rename-err">
              {renameError}
            </p>
          ) : null}
          <div className="wb-cloud-dialog-bar">
            <button
              className="wb-agent-cancel"
              data-testid="wb-cloud-rename-cancel"
              onClick={() => setRenameOf(null)}
            >
              {RENAME_LABELS.cancel}
            </button>
            <button
              className="wb-agent-start"
              data-testid="wb-cloud-rename-ok"
              onClick={() => {
                const target = renameOf;
                const plan = planRename(
                  target.name,
                  renameText,
                  entries.map((x) => x.name),
                );
                if (!plan.ok) {
                  setRenameError(plan.reason);
                  return;
                }
                setRenameOf(null);
                void (async () => {
                  if (!bridge?.drive) return;
                  const made = await bridge.drive.rename(target.path, plan.name);
                  setNote(made ? `已重命名为 ${made}` : "重命名失败");
                  await refresh();
                })();
              }}
            >
              {RENAME_LABELS.ok}
            </button>
          </div>
        </div>
      ) : null}

      {menu ? (
        <DriveRowMenu
          onAiReading={(entry) => {
            setMenu(null);
            void (async () => {
              if (!bridge?.drive) return;
              if (!isTextKind(entry.kind)) {
                setNote(`「${entry.name}」不是文本，读不了`);
                return;
              }
              const text = await bridge.drive.read(entry.path);
              if (text === null) {
                setNote("读不出来（可能是空文件或太大了）");
                return;
              }
              useReaderStore.getState().open(text, entry.name);
              useWorkbenchStore.getState().setView("reader");
            })();
          }}
          onRename={(entry) => {
            setMenu(null);
            setRenameOf(entry);
            setRenameText(entry.name);
            setRenameError("");
          }}
          onDelete={(entry) => {
            setMenu(null);
            setConfirmDel(entry);
          }}
          onDownload={(entry) => {
            setMenu(null);
            void (async () => {
              if (!bridge?.drive) return;
              setNote(DOWNLOAD_LABELS.downloading);
              const got = await bridge.drive.download(entry.path);
              setNote(downloadNote(got));
            })();
          }}
          entry={menu.entry}
          x={menu.x}
          y={menu.y}
          starred={starred.has(menu.entry.name)}
          onClose={() => setMenu(null)}
          onChanged={(text) => {
            setNote(text);
            void refresh();
          }}
        />
      ) : null}
    </section>
  );
}

/* ============================================================
 * 手机遥控电脑
 * ============================================================ */

export function PhonePage() {
  const bridge = (window as unknown as { shell?: ShellBridge }).shell;
  /*
   * 两个开关都是**真状态**，不是 useState：
   *   · 「可被同账号设备连接与控制」是**许可**，关掉后别的设备不该能连上 → 写盘；
   *   · 「让这台设备保持唤醒状态」是这台机器**当前的真实状态** → 主进程 powerSaveBlocker。
   * 原来两个都是本地 useState，重启就回到默认值，用户会以为"设了没用"。
   */
  const [allowConnect, setAllowConnect] = useState(true);
  const [keepAwake, setKeepAwake] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!bridge?.remote) {
      setLoaded(true);
      return;
    }
    void bridge.remote
      .status()
      .then((status) => {
        setAllowConnect(status.allowConnect);
        setKeepAwake(status.keepAwake);
      })
      .finally(() => setLoaded(true));
  }, [bridge]);

  const toggleConnect = () => {
    const next = !allowConnect;
    setAllowConnect(next);
    void bridge?.remote?.setAllowConnect(next);
  };

  const toggleAwake = () => {
    // 以主进程回给的真实状态为准 —— 不必信本地这一份记忆
    void bridge?.remote?.setKeepAwake(!keepAwake).then((actual) => setKeepAwake(actual));
  };

  return (
    <section className="wb-page" data-testid="wb-page-phone">
      <header className="wb-page-head">
        {/* 侧栏折叠：本机版还没做（参考实现里有）—— 标 disabled，不装作能用（§125/§126） */}
<button className="wb-icon" title="打开/收起左侧栏（本机版还没做折叠）" disabled>
          <List size={15} />
        </button>
        <span className="wb-spacer" />
        {!loaded ? <em className="wb-phone-loading">读取本机状态…</em> : null}
      </header>

      <div className="wb-page-body wb-phone-body">
        <div className="wb-phone-left">
          <div className="wb-mini-label">远程控制</div>
          <h2 className="wb-page-h2">出门也能操作电脑</h2>
          <p className="wb-page-p">
            用手机豆包在工作任务中，连接此电脑后，可远程继续任务，接收进度提醒，并调用这台电脑上的文件和工具。
          </p>

          <div className="wb-switch-list">
            <label className="wb-switch-row">
              <span className="wb-switch-icon is-blue">
                <Monitor size={15} />
              </span>
              <span className="wb-switch-text">可被同账号设备连接与控制</span>
              <button
                className={`wb-switch${allowConnect ? " is-on" : ""}`}
                data-testid="wb-switch-connect"
                onClick={toggleConnect}
                aria-pressed={allowConnect}
              >
                <span />
              </button>
            </label>
            <label className="wb-switch-row">
              <span className="wb-switch-icon is-green">
                <Clock size={15} />
              </span>
              <span className="wb-switch-text">让这台设备保持唤醒状态</span>
              <button
                className={`wb-switch${keepAwake ? " is-on" : ""}`}
                data-testid="wb-switch-awake"
                onClick={toggleAwake}
                aria-pressed={keepAwake}
              >
                <span />
              </button>
            </label>
          </div>

          <div className="wb-steps">
            <div className="wb-step">
              <span className="wb-step-num">1</span>
              <span>
                <b>打开手机豆包 App</b>
                <em>登录与当前电脑相同账号</em>
              </span>
            </div>
            <div className="wb-step">
              <span className="wb-step-num">2</span>
              <span>
                <b>在工作任务中选择电脑</b>
                <em>选择在线的电脑便可远程控制</em>
              </span>
            </div>
            <div className="wb-qr">
              {/*
                实机这里是一张真的二维码（扫了去下手机豆包）。
                本机版**没有配套手机端**，所以不画一张假的二维码 ——
                假码扫出来什么都没有，比一块说明更误导。
              */}
              <div className="wb-qr-box wb-qr-none" data-testid="wb-qr-unavailable">
                <Smartphone size={26} />
                <em>本机版不含手机端</em>
              </div>
              <em className="wb-qr-cap">下载或打开豆包 APP</em>
            </div>
          </div>
        </div>

        {/* 右侧样机：实机是一张手机截图，这里用 DOM 画出来，内容照实机的文案 */}
        <div className="wb-phone-mock" data-testid="wb-phone-mock" aria-hidden>
          <div className="wb-mock-screen">
            <div className="wb-mock-menu">
              <div className="wb-mock-menu-head">对话</div>
              {["工作电脑", "家里电脑", "云电脑"].map((name, i) => (
                <div className={`wb-mock-menu-row${i === 0 ? " is-on" : ""}`} key={name}>
                  工作任务 · {name}
                  {i === 0 ? <Check size={12} /> : null}
                </div>
              ))}
            </div>
            <div className="wb-mock-chips">
              {["工作电脑", "周报", "始终允许", "PPT"].map((chip) => (
                <span className="wb-mock-chip" key={chip}>
                  {chip}
                </span>
              ))}
            </div>
            <div className="wb-mock-input">发消息或按住说话...</div>
          </div>
          <div className="wb-mock-prompt">整理桌面上的 Word 文件</div>
          <div className="wb-mock-prompt">帮我清理电脑上大于 5G 的文件</div>
        </div>
      </div>
    </section>
  );
}
