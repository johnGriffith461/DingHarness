/**
 * 从 `pages.tsx` 拆出来的（C6-2）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆分理由见 `docs/PLAN-C6-结构拆分.md`（那个文件 1669 行 / 7 个顶层组件）。
 */

import { useEffect, useState } from "react";
import { Blocks, Check, ChevronDown, Cloud, FolderOpen, Plus, Sparkles } from "lucide-react";
import { NavCollapseButton } from "./NavCollapseButton";
import { SCHEDULED_RECOMMEND, SCHEDULED_SERVED_IDS, SCHEDULE_COMPOSER_PLACEHOLDER } from "./copy";
import { useScheduleStore } from "./scheduleStore";
import { useWorkbenchStore } from "./store";
import { describeNextRun, ENV_LABEL, MAX_CUSTOM_MINUTES, MIN_CUSTOM_MINUTES, REPEAT_LABEL, type RepeatType, type RunEnv } from "@shared/schedule";


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
    /*
     * 钟点（Phase 16）：默认填 22:00 —— "每晚汇总"是定时任务最常见的用法，
     * 而这个字段在这之前**根本配不出来**（daily 是"从创建时刻起算的 24 小时"）。
     */
    atHour: 22,
    atMinute: 0,
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
      /* 编辑已有任务时把它的钟点带进来（老任务没填 → 回落到 22:00 这个默认） */
      atHour: job.atHour ?? 22,
      atMinute: job.atMinute ?? 0,
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
<NavCollapseButton />
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
            {/*
              ⭐ 钟点（Phase 16）：daily / weekly 才出现。
              在这之前这两个档位是"从创建时刻起算的固定间隔"——用户 11:37 建的任务
              永远 11:37 跑，"每天早上 8 点汇总"配不出来。
            */}
            {draft.repeat === "daily" || draft.repeat === "weekly" ? (
              <label className="wb-sched-field">
                在
                <input
                  className="wb-sched-num"
                  type="number"
                  min={0}
                  max={23}
                  data-testid="wb-sched-hour"
                  value={draft.atHour}
                  onChange={(e) => setDraft({ ...draft, atHour: Number(e.target.value) })}
                />
                点
                <input
                  className="wb-sched-num"
                  type="number"
                  min={0}
                  max={59}
                  data-testid="wb-sched-minute"
                  value={draft.atMinute}
                  onChange={(e) => setDraft({ ...draft, atMinute: Number(e.target.value) })}
                />
                分
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

      {/*
        ⚠️ 这一条输入区是**照本体截图摆的样子**，但本机版没有"用一句话安排任务"的后端
        （定时任务的创建在上面那个表单里）—— 所以它整条都是**装饰**。

        ── 2026-10-15（M0 工单 3）：改成**非交互元素** ──

        原来这里是六颗 `disabled` 按钮，每颗挂一句"本机版还没做"。工单的口径是
        逐项三选一（实现 / 移除 / **降级为非交互元素**），**不允许留下"disabled + 借口"**。
        这里按第三条降级：换成 `span` + 外层 `aria-hidden`，不再伪装成按钮 ——
        那六句借口随之消失，其中两句还是**不实陈述**：
        「技能（本机版还没做）」「插件（本机版还没做）」与事实不符 ——
        技能面板与插件系统（Phase 8）都已落地，只是**定时任务还不能绑定它们**
        （`ScheduleJob` 只有 title / prompt / repeat，见 `scheduleStore.ts`）。
        这句话留在代码里，不再挂到界面上充数。
      */}
      <div className="wb-composer wb-composer-slim" aria-hidden="true">
        <div className="wb-composer-input wb-composer-placeholder">{SCHEDULE_COMPOSER_PLACEHOLDER}</div>
        <div className="wb-composer-bar">
          <span className="wb-chip">
            <Plus size={16} />
          </span>
          <span className="wb-chip">
            <Cloud size={13} /> 云电脑 <ChevronDown size={12} />
          </span>
          <span className="wb-chip">
            <FolderOpen size={13} /> 项目
          </span>
          <span className="wb-chip">
            <Sparkles size={13} /> 技能
          </span>
          <span className="wb-chip">
            <Blocks size={13} /> 插件
          </span>
          <span className="wb-spacer" />
          <span className="wb-chip wb-chip-auto">AUTO · LOW</span>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
 * 插件·技能·伙伴（Ctrl Shift S）
 * ============================================================ */

export const PLUGIN_CATEGORIES = [
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

