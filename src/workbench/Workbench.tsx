import { useEffect, useMemo, useRef, useState } from "react";
import {Blocks,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Clock,
  Copy,
  FileText,
  FolderOpen,
  GitBranch,
  HardDrive,
  HelpCircle,
  ListTodo,
  Monitor,
  MoreHorizontal,
  Paperclip,
  Phone,
  Plus,
  RotateCcw,
  Send,
  Settings,
  Share2,
  Smartphone,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Undo2,
  Volume2,
  X,
  PanelLeft,
} from "lucide-react";
import { useWorkbenchStore, openArtifact, revealArtifact, restoreTasks, startTaskPersistence, type WorkbenchView } from "./store";
import { DOC_CREATE_LABELS } from "@shared/doc";
import type { ShellBridge } from "@shared/ipc";
import type { DriveEntry } from "@shared/drive";
import { type TaskStep, currentQuestion, progressLabel, questionProgress, type WorkTask } from "./task";
import {
  PHRASE_LABELS,
  applyPhrase,
  detectAtTrigger,
  filterPhrases,
  phraseGroups,
  type AtTrigger,
  type Phrase,
} from "@shared/phrases";
import {
  ARTIFACT_TITLE_GENERATING,
  COMPOSER_PLACEHOLDER,
  SUMMARY_RECENT_FILES,
  SUMMARY_RECENT_LIMIT_NOTE,
  SUMMARY_SESSION_FILES,
  SUMMARY_TABS,
  splitSuggestion,
  type SummaryTabId,
} from "./copy";
import { suggestionIcon } from "./suggestionIcon";
import { CloudPage, PhonePage, PluginsPage, ScheduledPage } from "./pages";
import CanvasRuntime from "@/canvas/CanvasRuntime";
import ChatSidebar from "@/chat/ChatSidebar";
import { startScheduler } from "./scheduleStore";
import { useLibraryStore } from "./libraryStore";
import { findItemIn } from "./libraryStore";
import { startTheme } from "./theme";
import { matchShortcut, shortcutFor } from "./shortcuts";
import { SETTINGS_LABELS, pinnedLabel, pinnedStatus, routeOptions } from "@shared/settings";
import { ToolTraceList } from "./ToolTraceList";
import { ArtifactCard } from "./ArtifactCard";
import { useAppSettings } from "./appSettings";
import { listProviders } from "@/ai/aiClient";
import { CONFIRM_MODES as PERMISSION_MODES, type ConfirmMode } from "@shared/permissions";
import { REWIND_HINT } from "./checkpoint";
import { DocPanel } from "./DocPanel";
import { TaskCenterPage } from "./TaskCenterPage";
import { ReaderPanel } from "./ReaderPanel";
import { AgentCreatePanel } from "./AgentCreatePanel";
import { CodingPage } from "./CodingPage";
import { ImageGenPage } from "./ImageGenPage";
import { VideoGenPage } from "./VideoGenPage";
import { useAgentStore } from "./agentStore";
import { useSearchHistoryStore } from "./searchHistoryStore";
import { useMemoryStore } from "./memoryStore";
import { useReaderStore } from "./readerStore";
import { useDocStore } from "./docStore";
import { readConfirmMode, saveConfirmMode } from "./confirmMode";
import { startCanvasCommandHost } from "./canvasCommandHost";
import AccountMenu from "./AccountMenu";
import SkillPanel from "./SkillPanel";
import MemoryPanel from "./MemoryPanel";
import SettingsPages, { type SettingsSubPage } from "./SettingsPages";
import ThreadListPage from "./ThreadListPage";
import FloatingAssistant from "./FloatingAssistant";
import ContextMenu, { clampMenu } from "./ContextMenu";
import { resourceTypeOf } from "@shared/artifactProto";
import { ARTIFACT_FORMATS } from "./artifact";
import { findVoice, listVoices, readVoiceName, saveVoiceName } from "./tts";

/**
 * 工作台外壳（阶段 10）。
 *
 * 形态照原版实测还原（HANDOFF §25）：**三栏** —— 左导航 / 中任务 / 右摘要。
 * 我们之前只有「对话 + 画布」两栏，这一层是整个缺的。
 *
 * 三个必须做对的机制都在这里：
 *   · 任务自动命名（列表里显示的是归纳后的标题，不是原文）
 *   · 进度计时（已处理 N 秒 → 共用时 N 分 M 秒）
 *   · 澄清提问卡（同一张卡逐题推进，最多 3 题）
 */

const NAV: Array<{ view: WorkbenchView; label: string; icon: typeof ListTodo; shortcut?: string }> = [
  { view: "home", label: "新工作任务", icon: ListTodo, shortcut: shortcutFor("home") },
  { view: "scheduled", label: "定时任务", icon: Clock, shortcut: shortcutFor("scheduled") },
  { view: "plugins", label: "插件·技能·伙伴", icon: Blocks, shortcut: shortcutFor("plugins") },
  { view: "cloud", label: "云盘", icon: HardDrive, shortcut: shortcutFor("cloud") },
  { view: "phone", label: "手机遥控电脑", icon: Smartphone },
];

/** 每秒重算一次"已处理 N 秒"。 */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/* ============================================================
 * 左侧导航
 * ============================================================ */

function NavSidebar() {
  const view = useWorkbenchStore((s) => s.view);
  const tasks = useWorkbenchStore((s) => s.tasks);
  const activeId = useWorkbenchStore((s) => s.activeTaskId);
  const setView = useWorkbenchStore((s) => s.setView);
  const openTask = useWorkbenchStore((s) => s.openTask);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /*
   * 账号头像点开的是**下拉菜单**（不是直接开设置弹窗）——
   * 本体就是这样：菜单里有 设置 / 外观设置 / 收藏夹 / 官网 / 检查更新 /
   * 帮助与反馈 / 额度用量 / 添加账号 / 退出登录。
   */
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  /*
   * 主题在**根组件**这里应用一次 —— 不能只放在设置弹窗里。
   * 弹窗只在打开设置时挂载，所以启动时没人应用：本地存着 "dark"，
   * 界面却还是浅色（实测撞过：afterReload 的 stored=dark 而 bg 是白的）。
   * 两处都调 applyTheme，`classList.toggle` 是幂等的。
   */
  /*
   * 主题在**根组件**这里启动一次 —— 不能只放在设置里。
   * 设置类组件只在打开时挂载，启动时没人应用：本地存着深色、界面却还是浅色
   * （§87 实测撞过：刷新后 stored=dark 而底色是白的）。
   *
   * `startTheme` 另外负责「跟随系统」的监听 —— 系统换主题时界面立刻跟着变。
   */
  useEffect(() => startTheme(), []);

  const lib = useLibraryStore((s) => s.lib);
  const addProject = useLibraryStore((s) => s.addProject);
  const dropProject = useLibraryStore((s) => s.dropProject);
  const rename = useLibraryStore((s) => s.rename);
  const assignProject = useLibraryStore((s) => s.assignProject);
  const pin = useLibraryStore((s) => s.pin);
  const [newProject, setNewProject] = useState("");
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const renameTask = useWorkbenchStore((s) => s.renameTask);
  const dropTask = useWorkbenchStore((s) => s.dropTask);
  /** 行内 ⋯ 菜单的目标与坐标（实机是悬停露出，不是右键）。 */
  const [rowMenu, setRowMenu] = useState<{ task: WorkTask; x: number; y: number } | null>(null);

  const titleOf = (taskId: string) => tasks.find((t) => t.id === taskId)?.title ?? "";
  const pinnedTasks = lib.pinned.filter((id) => tasks.some((t) => t.id === id));
  /** 没归任何项目的任务才出现在「最近」里（归了就在项目下显示，避免一处两见）。 */
  const looseTasks = tasks.filter((t) => !lib.projects.some((p) => p.memberIds.includes(t.id)));

  return (
    <aside className="wb-nav" data-testid="wb-nav">
      <div className="wb-nav-head">
        <span className="wb-brand">豆包工作</span>
        <button className="wb-icon" title="后退" disabled>
          <ChevronRight size={14} style={{ transform: "rotate(180deg)" }} />
        </button>
        <button className="wb-icon" title="前进" disabled>
          <ChevronRight size={14} />
        </button>
        <button className="wb-icon" title="搜索（本机版是装饰：仿浏览器工具条）" data-testid="wb-search" disabled>
          <MoreHorizontal size={14} />
        </button>
      </div>

      <nav className="wb-nav-list">
        {NAV.map((item) => {
          const Icon = item.icon;
          const on = view === item.view || (item.view === "home" && view === "task");
          return (
            <button
              key={item.view}
              className={`wb-nav-item${on ? " is-on" : ""}`}
              data-testid={`wb-nav-${item.view}`}
              onClick={() => setView(item.view)}
            >
              <Icon size={15} />
              <span>{item.label}</span>
              {item.shortcut ? <em className="wb-kbd">{item.shortcut}</em> : null}
            </button>
          );
        })}
      </nav>

      {/* 置顶：上位把置顶、最近访问、进行中的任务放在一处，这里先做置顶 */}
      {pinnedTasks.length > 0 ? (
        <>
          <div className="wb-nav-section">置顶</div>
          <div className="wb-nav-items wb-nav-fixed">
            {pinnedTasks.map((id) => (
              <button
                key={id}
                className={`wb-nav-row${id === activeId ? " is-on" : ""}`}
                data-testid={`wb-pinned-${id}`}
                onClick={() => openTask(id)}
              >
                <ListTodo size={13} />
                <span className="wb-nav-row-title">{titleOf(id)}</span>
                <span
                  className="wb-nav-mini"
                  title="取消置顶"
                  data-testid={`wb-unpin-${id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    pin(id);
                  }}
                >
                  ★
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      {/* 项目：上位 groupChats_navBar_entry_groupByProject */}
      <div className="wb-nav-section">
        项目
        <button
          className="wb-nav-mini"
          title="新建项目"
          data-testid="wb-project-new"
          onClick={() => setCreating((v) => !v)}
        >
          ＋
        </button>
      </div>
      {creating ? (
        <div className="wb-nav-newform">
          <input
            className="wb-nav-input"
            placeholder="输入项目名称"
            data-testid="wb-project-name"
            value={newProject}
            autoFocus
            onChange={(e) => setNewProject(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const error = addProject(newProject);
                if (!error) {
                  setNewProject("");
                  setCreating(false);
                } else {
                  setNoteIfAny(error);
                }
              }
              if (e.key === "Escape") setCreating(false);
            }}
          />
        </div>
      ) : null}
      <div className="wb-nav-items wb-nav-fixed">
        {lib.projects.length === 0 ? (
          <div className="wb-nav-empty">还没有项目</div>
        ) : (
          lib.projects.map((project) => {
            const open = !collapsed.has(project.id);
            return (
              <div key={project.id}>
                <button
                  className="wb-nav-row"
                  data-testid={`wb-project-${project.id}`}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(project.id)) next.delete(project.id);
                      else next.add(project.id);
                      return next;
                    })
                  }
                >
                  <span className="wb-nav-mini">{open ? "▾" : "▸"}</span>
                  <span className="wb-nav-row-title">{project.name}</span>
                  <em className="wb-nav-count">{project.memberIds.length}</em>
                  <span
                    className="wb-nav-mini"
                    title="重命名"
                    data-testid={`wb-project-rename-${project.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const name = window.prompt("重命名项目", project.name);
                      if (name) rename(project.id, name);
                    }}
                  >
                    ✎
                  </span>
                  <span
                    className="wb-nav-mini"
                    title="删除项目（里面的任务不会被删）"
                    data-testid={`wb-project-del-${project.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      dropProject(project.id);
                    }}
                  >
                    ×
                  </span>
                </button>
                {open
                  ? project.memberIds.map((id) => (
                      <button
                        key={id}
                        className={`wb-nav-row wb-nav-child${id === activeId ? " is-on" : ""}`}
                        data-testid={`wb-project-member-${id}`}
                        onClick={() => openTask(id)}
                      >
                        <ListTodo size={13} />
                        <span className="wb-nav-row-title">{titleOf(id)}</span>
                        <span
                          className="wb-nav-mini"
                          title="移出项目"
                          onClick={(e) => {
                            e.stopPropagation();
                            assignProject(null, id);
                          }}
                        >
                          −
                        </span>
                      </button>
                    ))
                  : null}
              </div>
            );
          })
        )}
      </div>

      {/*
        「最近」这一栏的标题右侧挂「管理历史对话」的入口（本体 `chat/thread/list`）。
        ⚠️ 这个入口位置是**推断**的 —— 本体截图只给了那一页本身，看不出从哪点进去。
           等拿到证据再改（改这一处即可）。
      */}
      <div className="wb-nav-section">
        最近
        <button
          className="wb-nav-mini"
          title="管理历史对话"
          data-testid="wb-threads-open"
          onClick={() => setView("threads")}
        >
          ⋯
        </button>
        <button
          className="wb-nav-mini"
          title="任务中心"
          data-testid="wb-center-open"
          onClick={() => setView("center")}
        >
          任务中心
        </button>
      </div>
      <div className="wb-nav-items">
        {looseTasks.length === 0 ? (
          <div className="wb-nav-empty">还没有任务</div>
        ) : (
          looseTasks.slice(0, 12).map((task) => (
            <div className="wb-nav-rowwrap" key={task.id}>
              <button
                className={`wb-nav-row${task.id === activeId ? " is-on" : ""}`}
                data-testid={`wb-recent-${task.id}`}
                onClick={() => openTask(task.id)}
              >
                <ListTodo size={13} />
                <span className="wb-nav-row-title">{task.title}</span>
                {task.stage === "awaiting" ? (
                  <em className="wb-pending" data-testid={`wb-pending-${task.id}`}>
                    待确认
                  </em>
                ) : null}
              </button>
              {/*
                实机是**悬停才露出 ⋯**（不是右键）—— 见 `.verify\tour3\02-recent-context.png`。
                菜单项照上位的 `appEntryManage_bottomSheet_option_*`：置顶/取消置顶、重命名、移除。
              */}
              <button
                className="wb-nav-rowmore"
                title="更多"
                data-testid={`wb-rowmenu-${task.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setRowMenu({ task, ...clampMenu(r.right - 176, r.bottom + 4) });
                }}
              >
                ⋯
              </button>
            </div>
          ))
        )}
      </div>

      <button className="wb-account" data-testid="wb-account" onClick={() => setAccountMenuOpen((v) => !v)}>
        <span className="wb-avatar" />
        <span className="wb-account-text">
          <b>按时吃饭450</b>
          <em>标准套餐</em>
        </span>
        <Settings size={14} />
      </button>

      {accountMenuOpen ? (
        <AccountMenu
          onClose={() => setAccountMenuOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : null}
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}

      {/* 行内 ⋯ 菜单：置顶/取消置顶、重命名、归入项目、移出 */}
      {rowMenu ? (
        <ContextMenu
          testid="wb-navmenu"
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          items={[
            {
              label: lib.pinned.includes(rowMenu.task.id) ? "取消置顶" : "置顶",
              icon: "★",
              run: () => pin(rowMenu.task.id),
            },
            {
              label: "重命名",
              icon: "✎",
              run: () => {
                const name = window.prompt("重命名任务", rowMenu.task.title);
                if (name) renameTask(rowMenu.task.id, name);
              },
            },
            ...(lib.projects.length > 0
              ? lib.projects.map((p) => ({
                  label: `归入「${p.name}」`,
                  icon: "▤",
                  run: () => assignProject(p.id, rowMenu.task.id),
                }))
              : []),
            ...(lib.projects.some((p) => p.memberIds.includes(rowMenu.task.id))
              ? [{ label: "移出项目", icon: "−", run: () => assignProject(null, rowMenu.task.id) }]
              : []),
            {
              label: "移除",
              icon: "×",
              run: () => {
                /*
                 * 只是从列表里去掉。**不动磁盘上的产物** ——
                 * 产物是用户的东西，"移出一个任务"不该顺手把文件删了。
                 */
                dropTask(rowMenu.task.id);
              },
            },
          ]}
        />
      ) : null}
    </aside>
  );
}

/** 项目名重复之类的错误：用一个转瞬即逝的提示，不打断输入。 */
function setNoteIfAny(message: string): void {
  const el = document.querySelector('[data-testid="wb-project-name"]') as HTMLInputElement | null;
  if (el) {
    el.setCustomValidity(message);
    el.reportValidity();
    el.setCustomValidity("");
  }
}

/* ============================================================
 * 澄清提问卡
 * ============================================================ */

function QuestionCard({ task }: { task: WorkTask }) {
  const answer = useWorkbenchStore((s) => s.answer);
  const question = currentQuestion(task);
  const [custom, setCustom] = useState("");

  useEffect(() => {
    setCustom("");
  }, [question?.id]);

  if (!question) return null;

  return (
    <div className="wb-question" data-testid="wb-question-card">
      <div className="wb-question-head">
        <span className="wb-question-text">{question.text}</span>
        <span className="wb-question-page">
          <span data-testid="wb-question-progress">‹ {questionProgress(task)} ›</span>
          <button className="wb-icon" title="关闭" onClick={() => useWorkbenchStore.getState().abort()}>
            <X size={14} />
          </button>
        </span>
      </div>

      <div className="wb-options">
        {question.options.map((option, index) => (
          <button
            key={option.label}
            className="wb-option"
            data-testid={`wb-option-${index}`}
            onClick={() => void answer(option)}
          >
            <span className="wb-option-num">{index + 1}</span>
            <span className="wb-option-text">
              <b>{option.label}</b>
              {option.hint ? <em>{option.hint}</em> : null}
            </span>
            {index === 0 ? <Clipboard size={13} className="wb-option-tail" /> : null}
          </button>
        ))}
      </div>

      <div className="wb-question-foot">
        <input
          className="wb-question-input"
          data-testid="wb-custom-answer"
          placeholder="自定义描述..."
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom.trim()) void answer(undefined, custom);
          }}
        />
        <button
          className="wb-icon"
          data-testid="wb-custom-send"
          disabled={!custom.trim()}
          title="用这段描述回答"
          onClick={() => void answer(undefined, custom)}
        >
          <Plus size={15} />
        </button>
        <button className="wb-icon" title="语音输入（本机版还没做）" disabled>
          <Volume2 size={15} />
        </button>
      </div>
    </div>
  );
}

/* ============================================================
 * 消息操作栏（对标原版：复制/朗读/赞/踩/分享/重新生成/消耗/时间）
 * ============================================================ */

/**
 * 一条 AI 回复下方的操作栏。
 *
 * 实机是六个图标：复制 / 朗读 / 有帮助 / 没帮助 / 分享 / 重新生成 + 消耗 + 时间戳。
 *
 * **六个都要真的能用。** 原来只有「复制」是活的，其余五个点了没反应 ——
 * 那比不放这些图标更糟：用户会以为功能坏了，或者以为自己点错了地方。
 */
function MessageActions({ taskId, step, cost, at }: { taskId: string; step: TaskStep; cost?: number; at: number }) {
  const regenerate = useWorkbenchStore((s) => s.regenerate);
  const rate = useWorkbenchStore((s) => s.rate);
  const transcript = useWorkbenchStore((s) => s.transcript);
  /** 会话检查点（§151）：回退与分叉。 */
  const rewind = useWorkbenchStore((s) => s.rewindTask);
  const branch = useWorkbenchStore((s) => s.branchTask);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const text = step.text;

  const time = new Date(at);
  const stamp = `${time.getHours()}:${String(time.getMinutes()).padStart(2, "0")}`;

  /**
   * 把这条消息变成一篇文档（§172，`aiDoc_msgLongPressMenu_createDoc` = **创建文档**）。
   *
   * 建好之后**直接跳到文档面板**并把那句说完（`aiDoc_msgToDoc_placeholder`）——
   * 只说"已创建"却让用户自己去找，等于没做完。
   */
  const createDoc = async () => {
    const id = await useDocStore.getState().createFromText(text);
    if (!id) {
      flash(DOC_CREATE_LABELS.failed);
      return;
    }
    useDocStore.getState().open(id);
    useWorkbenchStore.getState().setView("doc");
  };

  /** 提示两秒后自己消失 —— 这种小反馈不该常驻占地方。 */
  const flash = (message: string) => {
    setHint(message);
    setTimeout(() => setHint((current) => (current === message ? "" : current)), 2000);
  };

  const speak = () => {
    const synth = window.speechSynthesis;
    if (!synth) {
      flash("这台机器没有语音合成");
      return;
    }
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    /*
     * 用设置里选的音色。**找不到就退回系统默认** ——
     * 换了机器/浏览器之后原来选的音色可能不在了，那时候不能什么都不念。
     */
    const chosen = findVoice(window.speechSynthesis.getVoices(), readVoiceName());
    if (chosen) utterance.voice = chosen;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => {
      setSpeaking(false);
      flash("朗读失败");
    };
    setSpeaking(true);
    synth.speak(utterance);
  };

  return (
    <div className="wb-actions" data-testid="wb-message-actions">
      <button
        className="wb-icon"
        title="复制"
        data-testid={`wb-act-copy-${step.id}`}
        onClick={() => {
          void navigator.clipboard.writeText(text);
          flash("已复制");
        }}
      >
        <Copy size={13} />
      </button>
      <button
        className={`wb-icon${speaking ? " is-on" : ""}`}
        title={speaking ? "停止朗读" : "朗读"}
        data-testid={`wb-act-speak-${step.id}`}
        onClick={speak}
      >
        <Volume2 size={13} />
      </button>
      <button
        className={`wb-icon${step.rating === "up" ? " is-on" : ""}`}
        title="有帮助"
        data-testid={`wb-act-up-${step.id}`}
        onClick={() => rate(step.id, "up")}
      >
        <ThumbsUp size={13} />
      </button>
      <button
        className={`wb-icon${step.rating === "down" ? " is-on" : ""}`}
        title="没帮助"
        data-testid={`wb-act-down-${step.id}`}
        onClick={() => rate(step.id, "down")}
      >
        <ThumbsDown size={13} />
      </button>
      <button
        className="wb-icon"
        title="分享（把整段对话复制成 Markdown）"
        data-testid={`wb-act-share-${step.id}`}
        onClick={() => {
          /*
           * 上位是走服务端生成分享链接。单机版没有那个后端，
           * 所以退化成"把整段对话复制成 Markdown" —— 这是**真的能拿出去用**的东西，
           * 而不是一个点了弹「暂不支持」的按钮。
           */
          const markdown = transcript();
          if (!markdown) {
            flash("没有可分享的内容");
            return;
          }
          void navigator.clipboard.writeText(markdown);
          flash("对话已复制成 Markdown");
        }}
      >
        <Share2 size={13} />
      </button>
      <button
        className="wb-icon"
        title={DOC_CREATE_LABELS.create}
        data-testid={`wb-act-createdoc-${step.id}`}
        onClick={() => void createDoc()}
      >
        <FileText size={13} />
      </button>
      <button
        className={`wb-icon${busy ? " is-spin" : ""}`}
        title="重新生成"
        data-testid={`wb-act-retry-${step.id}`}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void regenerate(taskId, step.id)
            .then(() => flash("已重新生成"))
            .finally(() => setBusy(false));
        }}
      >
        <RotateCcw size={13} />
      </button>
      {/*
        会话检查点（§151）：从这里往回退、或从这里分叉。
        两件事都**只改对话**，所以 title 里把"已发生的动作不撤销"讲在明处。
      */}
      <button
        className="wb-icon"
        title={`回到这一步（之后的轮次会丢掉）。${REWIND_HINT}`}
        data-testid={`wb-act-rewind-${step.id}`}
        onClick={() => {
          rewind(taskId, step.id);
          flash("已回到这一步");
        }}
      >
        <Undo2 size={13} />
      </button>
      <button
        className="wb-icon"
        title="从这里分叉：把到这一步为止的对话复制成一段新对话"
        data-testid={`wb-act-branch-${step.id}`}
        onClick={() => {
          branch(taskId, step.id);
          flash("已分叉成新对话");
        }}
      >
        <GitBranch size={13} />
      </button>
      {hint ? <span className="wb-act-hint" data-testid={`wb-act-hint-${step.id}`}>{hint}</span> : null}
      {typeof cost === "number" ? (
        <span className="wb-cost" title="本次消耗的额度">
          <Sparkles size={12} /> 消耗 {cost.toFixed(2)}
        </span>
      ) : null}
      <span className="wb-stamp">今天 {stamp}</span>
    </div>
  );
}


/* ============================================================
 * 任务视图
 * ============================================================ */

function TaskView() {
  const task = useWorkbenchStore((s) => s.tasks.find((t) => t.id === s.activeTaskId) ?? null);
  const tick = useTick(task?.stage === "running");
  const scroller = useRef<HTMLDivElement | null>(null);
  const openFloat = useWorkbenchStore((s) => s.openFloat);
  const scheduleFromTask = useWorkbenchStore((s) => s.scheduleFromTask);
  const renameTask = useWorkbenchStore((s) => s.renameTask);
  /** 放行/拒绝被闸门拦下的工具调用（§144）。 */
  const resolveTool = useWorkbenchStore((s) => s.resolveTool);
  /** 在这段对话里接着说一句（§147）。 */
  const sendInTask = useWorkbenchStore((s) => s.sendInTask);
  /** 标题改名：点标题进入，回车/失焦提交。 */
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [task?.steps.length, task?.stage]);

  if (!task) return <div className="wb-empty">没有打开的任务</div>;

  const progress = progressLabel(task, tick);

  return (
    <section className="wb-task" data-testid="wb-task">
      <header className="wb-task-head">
        {/*
          ⚠️ 这个按钮**标了 disabled**（§124 的死按钮审计报出来的）。

          它原本是个没有 onClick 的死按钮，而且**图标也不太对**
          （在"打开/收起左侧栏"的位置放了个 MoreHorizontal）。

          查过了：**项目里没有侧栏折叠机制**（store 与 Workbench 里都搜不到
          navCollapsed / navOpen 之类）。所以它不是"漏接线"，是**参考里有、
          我还没做**的功能。

          按本项目标准"如实呈现，不装作能用"，没实现的就不该可点 ——
          所以标 disabled，并把它记进待做（R5 视觉/体验收口）。
        */}
        <button className="wb-icon" title="打开/收起左侧栏（本机版还没做折叠）" disabled>
          <PanelLeft size={15} />
        </button>
        {/*
          重命名：原来是个**没有 onClick 的死按钮**（§124 审计报出）——
          而它要唤起的能力**早就做好了**：`renaming` state 与下面的
          `wb-task-rename-input` 都在，只是没人把 `setRenaming(true)` 接到这个按钮上。
        */}
        <button
          className="wb-icon"
          title="重命名"
          data-testid="wb-task-rename"
          onClick={() => setRenaming(true)}
        >
          <PenIcon />
        </button>
        <div className="wb-task-title">
          {renaming ? (
            <input
              className="wb-task-rename"
              data-testid="wb-task-rename-input"
              autoFocus
              defaultValue={task.title}
              onBlur={(e) => {
                renameTask(task.id, e.target.value);
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameTask(task.id, e.currentTarget.value);
                  setRenaming(false);
                }
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            /*
             * 实机里任务标题是**可点的**（标题后面跟一个 ›）。
             * 点它进入改名，比在旁边放个铅笔更顺 —— 铅笔那个是"编辑任务内容"，不是改标题。
             */
            <button
              className="wb-task-title-btn"
              data-testid="wb-task-title"
              title="点击重命名任务"
              onClick={() => setRenaming(true)}
            >
              {task.title} <span className="wb-task-title-tail">›</span>
            </button>
          )}
          <em>AI 生成可能有误 请核实</em>
        </div>
        {/*
          顶栏右侧那一排图标。实机第 3 个是**弹出悬浮助手窗**（独立可拖拽的快速问答面板）。
          其余几个（电话/定时/设备）是远端能力，这里只做图标占位，不做假功能。
        */}
        <button className="wb-icon" title="语音通话（未接入）" disabled>
          <Phone size={15} />
        </button>
        {/*
          ⏰ 用它把当前任务变成定时任务：跳到定时任务页并把标题与要做的事填好。
          **不直接建**：点一下凭空多出一个每天跑的任务会让人意外，
          建不建交给用户在表单里确认。
        */}
        <button
          className="wb-icon"
          title="用这个任务建一个定时任务"
          data-testid="wb-task-schedule"
          onClick={() => scheduleFromTask(task.title, task.brief)}
        >
          <Clock size={15} />
        </button>
        <button
          className="wb-icon"
          title="打开悬浮助手窗（随手问，不建任务）"
          data-testid="wb-float-open"
          onClick={() => openFloat()}
        >
          <Monitor size={15} />
        </button>
      </header>

      <div className="wb-stream" ref={scroller} data-testid="wb-stream">
        {task.steps.map((step) =>
          step.role === "user" ? (
            <div className="wb-bubble-user" key={step.id}>
              {step.text}
            </div>
          ) : (
            <div className="wb-assistant" key={step.id}>
              <div className="wb-assistant-text">{step.text}</div>
              {/*
                这一步用过的工具（§141）。
                放在正文**下面**：模型"调了工具"这件事用户得看得见 ——
                否则"记忆被写进去了"就是暗箱操作。这与本项目反复清的
                "看着有、其实没用"是反方向的要求：**真做了的事要看得出来**。
              */}
              {/* 工具留痕（§141/§185）：抽成了共享组件，聊天那边用同一个 */}
              <ToolTraceList
                id={step.id}
                traces={step.tools ?? []}
                onResolve={(toolCallId, approve) => void resolveTool(task.id, step.id, toolCallId, approve)}
              />
              {/*
                这一步额外要说的一件事（§149）：目前用于"更早的对话已压缩为摘要"。
                挂在步骤上而不是飘一个 toast —— 飘提示刷新就没了，
                回头翻这段对话会不知道当时上下文被压过。
              */}
              {step.note ? (
                <div className="wb-step-note" data-testid={`wb-note-${step.id}`}>
                  {step.note}
                </div>
              ) : null}
              {/* 这一步产出的产物：卡片就贴在这句话下面 */}
              {task.artifacts
                .filter((a) => a.stepId === step.id)
                .map((artifact) => (
                  <ArtifactCard key={artifact.id} artifact={artifact} />
                ))}
              <MessageActions taskId={task.id} step={step} cost={step.cost} at={step.at} />
            </div>
          ),
        )}

        {progress ? (
          /*
            `preamble-elapsed-timer` 是上位的稳定契约属性（自动化与埋点都挂在它上面），
            照抄下来，别人的脚本能直接对得上。
          */
          <div className="wb-progress" data-testid="wb-progress" data-preamble-elapsed-timer={task.stage}>
            <span data-testid="preamble-elapsed-timer">{progress}</span>
            {task.finishedAt !== null ? <ChevronRight size={13} /> : null}
          </div>
        ) : null}

        {task.activity && task.stage !== "done" ? (
          <div className="wb-activity">
            <HelpCircle size={13} /> {task.activity}
          </div>
        ) : null}
      </div>

      {currentQuestion(task) ? <QuestionCard task={task} /> : null}

      {/*
        ⭐ 任务视图的输入框是**接着聊**，不是新开一段（§147）。

        这里原来就是一个默认的 `<Composer />` —— 于是用户在对话里接着说一句，
        应用会**新建一个任务**，之前那几轮完全不在上下文里。
        本体不是这样（它的「主对话」是一段多轮对话）。
      */}
      <Composer onSend={(value) => void sendInTask(task.id, value)} />
    </section>
  );
}

/** 铅笔图标（lucide 的 Pen 在此处只用到一次，内联省一次 import）。 */
function PenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/* ============================================================
 * 输入区（对标原版：项目 / 按需确认 / 技能 / 插件 / 模型 / 麦克风）
 *
 * 原版的「环境选择器」已按用户要求删掉 —— 默认就是本地电脑，
 * 没有可选项时留着一个点了没用的 chip 不如不留。
 * ============================================================ */

/*
 * 三个档位的文案与判定**同源**（`@shared/permissions`）——
 * 原来这里自己写了一份 `CONFIRM_MODES`，而"判定"要用的也是同一张表：
 * 两处各写一份的话，改文案不会改到判定（本项目栽过多次的形态）。
 *
 * 默认值是「全部允许」：依据本体首页实机截图，输入区那一格显示的就是它。
 * （原来默认写的「按需确认」是我推的，不是本体的口径。）
 */
const CONFIRM_MODES = PERMISSION_MODES;

function Composer({
  placeholder = COMPOSER_PLACEHOLDER,
  sendLabel,
  onSend,
}: {
  placeholder?: string;
  sendLabel?: string;
  /**
   * 这一句往哪儿送（§147）。
   *
   * 缺省是 `createTask`（新开一段对话）—— 首页/新任务就是如此。
   * **任务视图传的是 `sendInTask`**（在这段对话里接着说），
   * 这也是这个组件从"只能发起任务"变成"能续聊"的那个接缝。
   */
  onSend?: (text: string) => void;
}) {
  const createTask = useWorkbenchStore((s) => s.createTask);
  const [text, setText] = useState("");

  /*
   * 「创作同款」这类按钮把一句话交过来（§159）：**取一次就清**。
   *
   * 只在这里 `take`，所以"谁负责清空"是明确的 ——
   * 否则那句草稿会一直躺在那儿，用户下次进首页又被填一遍。
   */
  const takeComposerDraft = useWorkbenchStore((s) => s.takeComposerDraft);
  useEffect(() => {
    const draft = takeComposerDraft();
    if (draft) setText(draft);
  }, [takeComposerDraft]);

  /*
   * 输入区那几个 chip 的下拉，**共用一个"当前打开的是哪个"状态**。
   *
   * 原来是四个独立布尔（projectOpen / confirmOpen / skillOpen / pluginOpen）——
   * 开第二个时不会关掉第一个，两个浮层就**叠在一起**（用户报的）。
   *
   * 换成单值之后，"最多只有一个开着"是**结构上保证的**，不靠每处记得去关别人。
   * 以后再加 chip 也不会重犯这个问题。
   */
  const [openPop, setOpenPop] = useState<null | "project" | "confirm" | "skill" | "plugin" | "add">(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  /*
   * 审批档位（§143）：
   * ① 初值从**持久化**读 —— 原来是写死「全部允许」的局部 state，
   *    用户选了「每步确认」、离开再回来就变回去了；
   * ② 选择时写回 —— 主进程的工具执行层要靠它做判定（随请求过界）。
   */
  const [confirmMode, setConfirmModeState] = useState<ConfirmMode>(() => readConfirmMode());
  const setConfirmMode = (mode: ConfirmMode): void => {
    saveConfirmMode(mode);
    setConfirmModeState(mode);
  };

  /**
   * 切换某个下拉的开合：开的若是它自己就关掉，否则换成它。
   *
   * @param which 要切换的下拉
   */
  const togglePop = (which: "project" | "confirm" | "skill" | "plugin" | "add"): void =>
    setOpenPop((cur) => (cur === which ? null : which));

  const installed = useLibraryStore((s) => s.lib.installed);
  const enabled = useLibraryStore((s) => s.lib.enabled);
  const enable = useLibraryStore((s) => s.enable);
  const lib = useLibraryStore((s) => s.lib);
  /** 已装项里按类型分开 —— 「插件」这个 chip 只看插件。 */
  const installedPlugins = installed.filter((id) => findItemIn(lib, id)?.type === "plugin");
  const enabledPlugins = enabled.filter((id) => findItemIn(lib, id)?.type === "plugin");

  /** 当前选中的项目名（没选则为 null，chip 上回落到"项目"）。 */
  const projectName = lib.projects.find((p) => p.id === projectId)?.name ?? null;

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    // 传了 onSend 就按它的（任务视图 = 在这段对话里接着说）；没传就是新开一段
    if (onSend) onSend(value);
    else void createTask(value);
  };

  const enabledNames = enabled.map((id) => findItemIn(lib, id)?.name).filter((x): x is string => Boolean(x));

  /*
   * `@` 常用语（§161）：证据里那句是
   * `coding_chat_mode_new_placeholder` = 输入"@"唤起常用语，或粘贴代码快速提问。
   *
   * 触发判定在纯逻辑里（`detectAtTrigger`）—— 尤其是**句中的 @ 不触发**（邮箱那种），
   * 这条最容易写错，单独测了。
   */
  const [atTrigger, setAtTrigger] = useState<AtTrigger | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /** 光标一动就重算（输入、点、方向键都算）。 */
  const syncTrigger = (el: HTMLTextAreaElement): void => {
    setAtTrigger(detectAtTrigger(el.value, el.selectionStart ?? el.value.length));
  };

  const matched = atTrigger ? filterPhrases(atTrigger.query) : [];

  /** 选中一条：替换 `@查询词`，并把光标放到插入内容的末尾。 */
  const pickPhrase = (phrase: Phrase): void => {
    if (!atTrigger) return;
    const next = applyPhrase(text, atTrigger, phrase);
    setText(next.text);
    setAtTrigger(null);
    // 光标要等这一帧渲染完再落（否则会被 value 覆盖回末尾）
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      }
    });
  };

  return (
    <div className="wb-composer" data-testid="wb-composer">
      {atTrigger ? (
        /*
         * ⚠️ `onMouseDown` 里 `preventDefault()` 是必须的：
         * 不然点选单会先让输入框 `blur` → 我的 `onBlur` 把 `atTrigger` 清成 null →
         * 紧接着的 `onClick` 拿到的是 null，于是**菜单关了但什么都没替换**。
         * （第一版就是这么错的：点了没反应，看着像"点不动"。）
         */
        <div
          className="wb-phrase-menu"
          data-testid="wb-phrase-menu"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="wb-phrase-head">{PHRASE_LABELS.title}</div>
          {matched.length === 0 ? (
            <p className="wb-phrase-empty" data-testid="wb-phrase-empty">
              {PHRASE_LABELS.empty}
            </p>
          ) : (
            phraseGroups().map((group) => {
              const items = matched.filter((p) => p.group === group);
              if (!items.length) return null;
              return (
                <div key={group}>
                  <div className="wb-phrase-group">{group}</div>
                  {items.map((p) => (
                    <button
                      key={p.id}
                      className="wb-phrase-item"
                      data-testid={`wb-phrase-${p.id}`}
                      onClick={() => pickPhrase(p)}
                    >
                      {p.title}
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      ) : null}
      <textarea
        ref={inputRef}
        className="wb-composer-input"
        data-testid="wb-composer-input"
        rows={2}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          syncTrigger(e.target);
        }}
        onKeyUp={(e) => {
          /*
           * ⚠️ Esc 之后**不能**再同步一次：`keyup` 晚于 `keydown`，
           * 而按 Esc 时正文没变（还是 `@xxx`），重算一遍触发条件就又成立 ——
           * 于是"按 Esc 收起"立刻被自己重新打开。
           */
          if (e.key === "Escape") return;
          syncTrigger(e.currentTarget);
        }}
        onClick={(e) => syncTrigger(e.currentTarget)}
        onBlur={() => setAtTrigger(null)}
        onKeyDown={(e) => {
          // 选单开着时：Esc 收起、Enter 选第一条（别让它顺手把消息发出去）
          if (atTrigger) {
            if (e.key === "Escape") {
              e.preventDefault();
              setAtTrigger(null);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && matched.length) {
              e.preventDefault();
              pickPhrase(matched[0] as Phrase);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="wb-composer-bar">
        {/*
          输入区的 `+`：原来是个**禁用按钮**（"本机版还没接原生文件对话框"）。
          本体这个位置里有「新建文档」（`doc_create` / `create_document_button_title`），
          所以这里做个真菜单 —— 至少「新建文档」是真的能用的。
        */}
        <div className="wb-chip-wrap">
          <button
            className="wb-icon"
            title="更多"
            data-testid="wb-composer-add"
            onClick={() => togglePop("add")}
          >
            <Plus size={16} />
          </button>
          {openPop === "add" ? (
            <div className="wb-chip-pop" data-testid="wb-add-pop" onMouseLeave={() => setOpenPop(null)}>
              <button
                className="wb-chip-option"
                data-testid="wb-add-doc"
                onClick={() => {
                  setOpenPop(null);
                  void useDocStore.getState().create().then(() => useWorkbenchStore.getState().setView("doc"));
                }}
              >
                新建文档
              </button>
              <button
                className="wb-chip-option"
                data-testid="wb-add-reader"
                onClick={() => {
                  setOpenPop(null);
                  useWorkbenchStore.getState().setView("reader");
                }}
              >
                进入 AI 阅读
              </button>
              <button
                className="wb-chip-option"
                data-testid="wb-add-agent"
                onClick={() => {
                  setOpenPop(null);
                  useWorkbenchStore.getState().setView("agent");
                }}
              >
                创建 AI 智能体
              </button>
              <button
                className="wb-chip-option"
                data-testid="wb-add-coding"
                onClick={() => {
                  setOpenPop(null);
                  useWorkbenchStore.getState().setView("coding");
                }}
              >
                创作广场
              </button>
              <button
                className="wb-chip-option"
                data-testid="wb-add-image"
                onClick={() => {
                  setOpenPop(null);
                  useWorkbenchStore.getState().setView("image");
                }}
              >
                图片生成
              </button>
              <button
                className="wb-chip-option"
                data-testid="wb-add-video"
                onClick={() => {
                  setOpenPop(null);
                  useWorkbenchStore.getState().setView("video");
                }}
              >
                视频生成
              </button>
              <span className="wb-chip-hint">附件：本机版还没接原生文件对话框</span>
            </div>
          ) : null}
        </div>

        {/*
          项目：原来是个**没有 onClick 的按钮**（点了一点反应没有）。
          现在挂上真下拉 —— 列出已有的项目，选中的会跟着这次任务走。
        */}
        <div className="wb-chip-wrap">
          <button
            className={`wb-chip${projectId ? " is-on" : ""}`}
            data-testid="wb-project"
            title="选择项目"
            onClick={() => togglePop("project")}
          >
            <Paperclip size={13} /> {projectName ?? "项目"} <ChevronDown size={12} />
          </button>
          {openPop === "project" ? (
            <div className="wb-chip-pop" data-testid="wb-project-pop" onMouseLeave={() => setOpenPop(null)}>
              {lib.projects.length === 0 ? (
                <div className="wb-chip-empty">还没有项目</div>
              ) : (
                lib.projects.map((p) => (
                  <button
                    key={p.id}
                    className={`wb-chip-option${projectId === p.id ? " is-on" : ""}`}
                    data-testid={`wb-project-option-${p.id}`}
                    onClick={() => {
                      setProjectId(p.id);
                      setOpenPop(null);
                    }}
                  >
                    <Paperclip size={13} /> {p.name} {projectId === p.id ? <Check size={13} /> : null}
                  </button>
                ))
              )}
              {projectId ? (
                <button
                  className="wb-chip-option"
                  data-testid="wb-project-clear"
                  onClick={() => {
                    setProjectId(null);
                    setOpenPop(null);
                  }}
                >
                  <X size={13} /> 不归入项目
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* 按需确认：同样是**没有 onClick 的死按钮**，现在挂上真下拉 */}
        <div className="wb-chip-wrap">
          <button
            className="wb-chip"
            data-testid="wb-confirm"
            title="执行前的确认策略"
            onClick={() => togglePop("confirm")}
          >
            <Check size={13} /> {confirmMode} <ChevronDown size={12} />
          </button>
          {openPop === "confirm" ? (
            <div className="wb-chip-pop" data-testid="wb-confirm-pop" onMouseLeave={() => setOpenPop(null)}>
              {CONFIRM_MODES.map((m) => (
                <button
                  key={m}
                  className={`wb-chip-option${confirmMode === m ? " is-on" : ""}`}
                  data-testid={`wb-confirm-option-${m}`}
                  onClick={() => {
                    setConfirmMode(m);
                    setOpenPop(null);
                  }}
                >
                  <Check size={13} /> {m} {confirmMode === m ? <Check size={13} /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/*
          「技能」按钮打开的是**装过的**条目清单，点一下切换"这次用不用"。
          启用项会作为能力说明交给任务（见 library.ts 的 enabledPromptBlock）——
          上位是把 skill_id 交给服务端注入 schema，单机版没有那一层，
          所以退化成"在系统提示词里说清楚这次可以用什么"。
        */}
        <div className="wb-env">
          <button
            className="wb-chip"
            data-testid="wb-skills"
            title="选择这次任务要用的技能 / 插件"
            onClick={() => togglePop("skill")}
          >
            <Sparkles size={13} /> 技能
            {enabled.length > 0 ? <em className="wb-chip-badge">{enabled.length}</em> : null}
          </button>
          {/*
            命令面板（命令 + 推荐 + 搜索）—— 形态依据本体实机截图（§132）。
            原来这里列的是「已装条目 + 勾选」，与本体不是一回事。
          */}
          {openPop === "skill" ? (
            <SkillPanel onClose={() => setOpenPop(null)} />
          ) : null}
        </div>

        {/*
          插件：原来是个**没有 onClick 的死按钮**（§124 的死按钮审计里报出来的）。
          旁边「技能」那个是完整下拉，但它的列表是**技能+插件混在一起**的 ——
          所以这个的位置是"只看插件"。
        */}
        <div className="wb-env">
          <button
            className="wb-chip"
            data-testid="wb-plugins"
            title="选择这次任务要用的插件"
            onClick={() => togglePop("plugin")}
          >
            <Blocks size={13} /> 插件
            {enabledPlugins.length > 0 ? <em className="wb-chip-badge">{enabledPlugins.length}</em> : null}
          </button>
          {openPop === "plugin" ? (
            <div className="wb-env-pop wb-skill-pop" data-testid="wb-plugin-pop">
              {installedPlugins.length === 0 ? (
                <div className="wb-skill-empty">还没安装任何插件。去「插件·技能·伙伴」里装几个。</div>
              ) : (
                installedPlugins.map((id) => {
                  const item = findItemIn(lib, id);
                  if (!item) return null;
                  const on = enabled.includes(id);
                  return (
                    <button
                      key={id}
                      className={`wb-env-option${on ? " is-on" : ""}`}
                      data-testid={`wb-plugin-toggle-${id}`}
                      onClick={() => enable(id)}
                    >
                      {item.name}
                      {on ? <Check size={13} /> : null}
                    </button>
                  );
                })
              )}
            </div>
          ) : null}
        </div>

        <span className="wb-spacer" />

        {/*
          ⚠️ 模型档位标 disabled（§124 的死按钮审计报出）。

          它显示的是**写死的"自动 低"** —— 而项目里并没有"档位"这个概念：
          本机版已有 `resolveRoute` / `readSavedRoute`（读写保存的通道），
          但没有"把模型/思考档位分成几档"的那一层。

          所以属于"参考里有、我还没做"，按标准禁用并记进待做。
        */}
        <button className="wb-chip" title="模型档位（本机版还没做档位选择）" disabled>
          自动 <ChevronDown size={12} /> 低
        </button>
        <button
          className="wb-send"
          data-testid="wb-send"
          disabled={!text.trim()}
          title={sendLabel ?? "发送（Enter）"}
          onClick={submit}
        >
          <Send size={15} />
        </button>
      </div>

      {enabledNames.length > 0 ? (
        <div className="wb-composer-chips" data-testid="wb-enabled-chips">
          {enabledNames.map((name) => (
            <span className="wb-composer-chip" key={name}>
              <Sparkles size={11} /> {name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================
 * 首页（blob + 今天有什么工作要处理? + 为你推荐）
 * ============================================================ */

function HomeView() {
  const suggestions = useWorkbenchStore((s) => s.suggestions);
  const createTask = useWorkbenchStore((s) => s.createTask);

  return (
    <section className="wb-home" data-testid="wb-home">
      <div className="wb-home-scroll">
        <div className="wb-blob" aria-hidden />
        <h1 className="wb-home-title">今天有什么工作要处理?</h1>
        <div className="wb-home-label">为你推荐</div>
        <div className="wb-suggestions">
          {suggestions.map((raw) => {
            /*
             * 形态照本体首页实机截图：一行是「类目图标 + 类目 + 指令」。
             * 之前渲染的是**一整条字符串**（`PPT 制作一份 TED 风格演讲`）+ 一枚统一的 ✨，
             * 与实机不像：本体每个类目**各自一枚图标**，且类目与指令是两段。
             */
            const { tag, text } = splitSuggestion(raw);
            const Icon = suggestionIcon(tag);
            return (
              <button
                key={raw}
                className="wb-suggestion"
                data-testid={`wb-suggestion-${tag}`}
                onClick={() => void createTask(raw)}
              >
                <span className="wb-suggestion-icon" aria-hidden>
                  <Icon size={11} />
                </span>
                <span className="wb-suggestion-tag">{tag}</span>
                {text ? <span className="wb-suggestion-text">{text}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <Composer />
    </section>
  );
}

/* ============================================================
 * 右侧「对话摘要」面板
 * ============================================================ */

/**
 * 右侧「对话摘要」面板。
 *
 * 上位这里是**四个 tab** —— 从它的 i18n 表里读到（`sidePanel_summary_tab_*`）：
 * `产物 / 浏览器 / 图片与视频 / 子智能体`。我早期只做了「对话产物」一块，
 * 那是把其中一个 tab 当成了整个面板。
 *
 * 「产物」是真文件（阶段 11.1/11.2）：任务产出后落到 `<userData>/artifacts/`，
 * 点标题用系统默认程序打开、点图标在文件管理器里定位。
 */
function SummaryPanel() {
  const task = useWorkbenchStore((s) => s.tasks.find((t) => t.id === s.activeTaskId) ?? null);
  const [tab, setTab] = useState<SummaryTabId>("artifacts");
  const [opening, setOpening] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");

  const artifacts = task?.artifacts ?? [];

  return (
    <aside className="wb-summary" data-testid="wb-summary">
      <header className="wb-summary-head">
        <span>对话摘要</span>
        <button className="wb-icon" title="摘要设置（本机版没有后端）" disabled>
          <Settings size={14} />
        </button>
        <button className="wb-icon" title="收起（本机版还没做面板折叠）" disabled>
          <MoreHorizontal size={14} />
        </button>
      </header>

      <div className="wb-tabs wb-summary-tabs" data-testid="wb-summary-tabs">
        {SUMMARY_TABS.map((t) => (
          <button
            key={t.id}
            className={`wb-tab${tab === t.id ? " is-on" : ""}`}
            data-testid={`wb-summary-tab-${t.id}`}
            title={t.key}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "artifacts" ? (
        <div className="wb-summary-section">
          <div className="wb-summary-title">
            {SUMMARY_SESSION_FILES} <Plus size={13} />
          </div>
          {/* 上位说明：面板只扫会话里最近若干条消息的产物 */}
          <div className="wb-summary-desc" data-testid="wb-summary-desc">
            {SUMMARY_RECENT_LIMIT_NOTE}
          </div>
          {artifacts.length === 0 ? (
            <div className="wb-summary-empty" data-testid="wb-artifacts-empty">
              {task && task.stage === "done" ? "暂无产物" : "暂无"}
            </div>
          ) : (
            <div className="wb-artifacts" data-testid="wb-artifacts">
              {artifacts.map((artifact) => (
                <div className="wb-artifact" key={artifact.id} data-testid={`wb-artifact-${artifact.id}`}>
                  <button
                    className="wb-artifact-main"
                    title={artifact.filePath ?? "尚未落盘"}
                    /* 上位产物卡的稳定钩子之一，埋点与自动化都依赖它 */
                    data-office-artifact-card-kind={artifact.kind}
                    /*
                     * 协议类型编号。**两处渲染都要给** ——
                     * 同一份产物既出现在对话流里、也出现在右侧「对话产物」里，
                     * 只给一处的话，靠这个属性做的检查会随"看的是哪一处"而结论不同。
                     */
                    data-artifact-resource-type={resourceTypeOf(artifact.kind)}
                    onClick={() => {
                      if (!artifact.filePath) {
                        setNote("这个产物还没落盘");
                        return;
                      }
                      setOpening(artifact.id);
                      void openArtifact(artifact.filePath)
                        .then((error) => setNote(error ? `打不开：${error}` : ""))
                        .finally(() => setOpening(null));
                    }}
                  >
                    <span className={`wb-artifact-kind is-${artifact.kind}`}>
                      {ARTIFACT_FORMATS[artifact.kind].label}
                    </span>
                    <span className="wb-artifact-title">{artifact.title}</span>
                    <span className="wb-artifact-status" data-office-artifact-status={artifact.status}>
                      {artifact.status === "generating" ? ARTIFACT_TITLE_GENERATING : ""}
                    </span>
                    {opening === artifact.id ? <em className="wb-artifact-size">打开中…</em> : null}
                    {typeof artifact.bytes === "number" && opening !== artifact.id ? (
                      <em className="wb-artifact-size">{formatBytes(artifact.bytes)}</em>
                    ) : null}
                  </button>
                  <button
                    className="wb-icon"
                    title="在文件夹里定位"
                    data-testid={`wb-artifact-reveal-${artifact.id}`}
                    onClick={() => {
                      if (artifact.filePath) void revealArtifact(artifact.filePath);
                    }}
                  >
                    <FolderOpen size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {note ? (
            <div className="wb-summary-note" data-testid="wb-artifact-note">
              {note}
            </div>
          ) : null}
        </div>
      ) : tab === "media" ? (
        <MediaTab />
      ) : (
        <div className="wb-summary-section">
          <div className="wb-summary-title">{SUMMARY_TABS.find((t) => t.id === tab)?.label}</div>
          {/*
            这两个 tab 如实说明为什么是空的。

            ⚠️ 2026-10-13 更正一处**不实陈述**：子智能体那一句原来写着
            「本次实现不含子智能体调度」—— 而子智能体**早就落地了**（§150 端到端验过、
            §176 补了"上交父级就地批准"）。它只是**没有单独列在这里**：
            它跑完记在**发起它的那一步**上（那一行写着步数与用量，被拦下的动作也挂在那一步上）。
            这里说清"为什么空"与"去哪看"，不给一个和自己代码相反的说明。
          */}
          <div className="wb-summary-empty" data-testid={`wb-summary-empty-${tab}`}>
            {tab === "browser"
              ? "浏览器操作会话会出现在这里（需要「操作浏览器」能力接入）"
              : "子智能体不单独列在这里：它跑完记在发起它的那一步上（工具留痕里写着步数与用量）"}
          </div>
        </div>
      )}

      <div className="wb-summary-section">
        <div className="wb-summary-title">技能</div>
        <div className="wb-summary-empty">暂无</div>
      </div>

      <div className="wb-summary-section">
        <div className="wb-summary-title">{SUMMARY_RECENT_FILES}</div>
        <div className="wb-summary-empty">暂无</div>
      </div>
    </aside>
  );
}

/** 字节数说成人话。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 「图片与视频」tab —— **真实画廊**。
 *
 * 数据来自云盘那三个真实目录（产物 / 导出 / 云盘本体）里扩展名属于图片的文件。
 * 缩略图走 `dshasset://file/<origin>/<名字>`（这一档走 path 而不是 host，
 * 因为 standard 协议会把 host 小写化，中文文件名会取不到）。
 *
 * 视频这一类在本机是空的 —— 不是没做，而是**这个 Key 下一个视频模型都没有**，
 * 界面上如实写明。
 */
function MediaTab() {
  const [images, setImages] = useState<DriveEntry[]>([]);
  const [videos, setVideos] = useState<DriveEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const bridge = (window as unknown as { shell?: ShellBridge }).shell;
    if (!bridge?.drive) {
      setLoading(false);
      return;
    }
    void bridge.drive
      .list()
      .then((list) => {
        const entries = list as DriveEntry[];
        setImages(entries.filter((e) => e.kind === "image"));
        setVideos(entries.filter((e) => /\.(mp4|webm|mov|mkv)$/i.test(e.name)));
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="wb-summary-section">
      <div className="wb-summary-title">
        图片与视频
        {images.length + videos.length > 0 ? (
          <em className="wb-media-count">{images.length + videos.length}</em>
        ) : null}
      </div>
      {loading ? (
        <div className="wb-summary-empty">读取中…</div>
      ) : images.length + videos.length === 0 ? (
        <div className="wb-summary-empty" data-testid="wb-media-empty">
          还没有图片或视频。在画布上生成图片、或往云盘里传图片，都会出现在这里。
        </div>
      ) : (
        <div className="wb-media" data-testid="wb-media">
          {images.map((entry) => (
            <button
              className="wb-media-cell"
              key={entry.path}
              title={`${entry.name}（${formatBytes(entry.bytes)}）`}
              data-testid={`wb-media-${entry.name}`}
              onClick={() => void revealArtifact(entry.path)}
            >
              <img
                className="wb-media-thumb"
                src={`dshasset://file/${entry.origin}/${encodeURIComponent(entry.name)}`}
                alt={entry.name}
                draggable={false}
                onError={(e) => {
                  // 取不到就退成文件名块，不留一个破图
                  const el = e.currentTarget;
                  el.style.display = "none";
                  el.parentElement?.classList.add("is-broken");
                }}
              />
              <span className="wb-media-name">{entry.name}</span>
            </button>
          ))}
          {videos.map((entry) => (
            <button
              className="wb-media-cell is-video"
              key={entry.path}
              title={entry.name}
              onClick={() => void revealArtifact(entry.path)}
            >
              <span className="wb-media-name">▶ {entry.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="wb-summary-desc" data-testid="wb-media-note">
        视频生成接口已接（Lunora /v1/videos），但当前 Key 下没有可用的视频模型
      </div>
    </div>
  );
}

/* ============================================================
 * 设置弹窗
 * ============================================================ */

function SettingsDialog({ onClose }: { onClose: () => void }) {
  /*
   * 记忆面板的开合与真实条数。
   *
   * 条数从 store 取 —— 写死一个"已启用"是之前那个错误说法的来源之一。
   */
  /** 当前在设置的哪个子页（null = 显示主列表）。 */
  const [subPage, setSubPage] = useState<SettingsSubPage | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const memCount = useMemoryStore((s) => s.lib.entries.length);
  /** 记忆开关（列表里那一行的 value 用它）。 */
  const memOn = useMemoryStore((s) => s.lib.enabled !== false);
  /** 新对话默认模型（§183）：空串 = 记忆上次。 */
  const pinnedModel = useAppSettings((s) => s.pinnedModel);
  /** 可选的通道（从 provider 列表摊出来）。 */
  const [modelChoices, setModelChoices] = useState<Array<{ provider: string; model: string; label: string }>>([]);
  useEffect(() => {
    // 这个组件本身就是设置弹窗：挂载时列一次就够了
    void (async () => {
      try {
        const providers = await listProviders();
        setModelChoices(routeOptions(providers));
      } catch {
        setModelChoices([]);
      }
    })();
  }, []);
  /** 钉住的默认模型现在还能用吗（§184）。 */
  const pinnedDead =
    pinnedStatus(
      pinnedModel,
      modelChoices.map((c) => `${c.provider}/${c.model}`),
    ) === "dead";
  const loadMemory = useMemoryStore((s) => s.load);
  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState(() => readVoiceName());

  // getVoices() 第一次常是空的，要听 voiceschanged（见 tts.ts 里的说明）
  useEffect(() => listVoices(setVoices), []);

  /*
   * 「套餐」在本机版的真实对应物就是**当前在用的模型通道** —— 写死一个「已开通」
   * 什么都没说明，用户想知道的是"我这些话是谁在回答"。
   * 没设置过时如实说"还没选"，并说明首次发消息会自动挑一个（那是实际行为）。
   */
  const channel = (() => {
    try {
      const raw = localStorage.getItem("dsh-canvas.chat-settings");
      if (!raw) return "";
      const parsed = JSON.parse(raw) as { provider?: string; model?: string };
      const provider = parsed.provider ?? "";
      const model = parsed.model ?? "";
      return provider ? `${provider}${model ? ` · ${model}` : ""}` : "";
    } catch {
      return "";
    }
  })();
  const rows = [
    /*
      标准套餐：对应本体 `chat/settings/profile`（独立页）。
      它原来带 `todo`，而渲染里 `disabled={Boolean(r.todo)}` —— 于是整行点不动。
      `todo` 的语义是"这行为什么不可用"，这里不该用它：通道信息改成 `value` 的副标题。
    */
    {
      group: 0,
      icon: "★",
      label: "标准套餐",
      value: channel || "还没选模型通道",
    },
    /* 账号：对应本体 chat/settings/account（独立页） */
    { group: 0, icon: "☺", label: "账号", value: "本机模式" },
    /*
      通用（§182）：记忆开关与「开启新话题」都在这儿。
      这一行的 value 直接显示**记忆现在开着没有** —— 在设置列表里就能看见状态，
      不用点进去才发现。
    */
    {
      group: 0,
      icon: "☺",
      label: "通用",
      /*
       * 这一行的 value 把两件事都说了：记忆开着没有 + 新对话默认模型是什么。
       * 设置列表里就能看见状态，不用点进去才发现（§182 定的规矩）。
       */
      /*
       * 钉住的模型要是**现在不可用**，这一行直接标出来（§184）：
       * 不能让用户以为默认在用 A、其实早就退回上次了。
       */
      value: `${SETTINGS_LABELS.memory}${memOn ? SETTINGS_LABELS.memoryOn : SETTINGS_LABELS.memoryOff} · ${
        SETTINGS_LABELS.defaultModel
      }${pinnedLabel(pinnedModel)}${pinnedDead ? "（不可用）" : ""}`,
    },
    /* 关于（§182）：只说本机这一份的事实 */    { group: 1, icon: "☺", label: "关于", value: "" },
    { group: 0, icon: "◈", label: "订阅与额度管理", todo: "需要账号服务端，本机版没有" },
    { group: 1, icon: "♪", label: "声音选择" },
    /*
      记忆：原来写着「本机版没有」+ 写死的"已启用" —— 那是**错的**。
      本体路由里有 `chat/memory/list|clear|delete`，它就是个真实功能，
      内容存本地一样成立。现在 value 显示**真实条数**，点开就是记忆面板。
    */
    { group: 1, icon: "◔", label: "记忆", value: memCount === 0 ? "暂无" : `${memCount} 条` },
  ];
  return (
    <div className="wb-modal-mask" onClick={onClose} data-testid="wb-settings">
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <button className="wb-modal-close" onClick={onClose} title="关闭">
          <X size={15} />
        </button>
        <div className="wb-modal-avatar" />
        <div className="wb-modal-name">
          按时吃饭450 <ChevronRight size={13} />
        </div>
        <div className="wb-modal-id">豆包号: user_QVqiCFv60</div>
        <button className="wb-modal-primary" disabled title="本机版没有账号服务端">豆包账号管理</button>

        {subPage ? (
          <SettingsPages
            page={subPage}
            pinned={pinnedModel}
            choices={modelChoices}
            onBack={() => setSubPage(null)}
            /*
             * 「开启新话题」：真的开一段新对话（新任务 = 空上下文），
             * 并照 `settings_clear_context_toast_new` 说一句「已开启新话题」。
             */
            onNewTopic={() => {
              /*
               * 「开启新话题」= 回到「新工作任务」的空上下文状态（§182）。
               * 用视图切换而不是"再造一个空任务"：后者会在历史里留一条空任务。
               */
              useWorkbenchStore.getState().setView("home");
              setSubPage(null);
              onClose();
            }}
          />
        ) : (
          <>
        {[0, 1].map((group) => (
          <div className="wb-modal-group" key={group}>
            {rows
              .filter((r) => r.group === group)
              .map((r) => (
                <div key={r.label}>
                  <button
                    className={`wb-modal-row${r.todo ? " is-todo" : ""}`}
                    data-testid={`wb-set-${r.label}`}
                    title={r.todo ?? ""}
                    disabled={Boolean(r.todo)}
                    onClick={() => {
                      if (r.label === "记忆") {
                        setMemoryOpen((v) => !v);
                        return;
                      }
                      if (r.label === "声音选择") {
                        setVoiceOpen((v) => !v);
                        return;
                      }
                      /*
                        标准套餐 / 账号：本体里是**独立路由**
                        （`chat/settings/profile` / `chat/settings/account`），
                        我把它们做成了弹窗里的子页（同「记忆」那套做法）。
                      */
                      if (r.label === "标准套餐") {
                        setSubPage("profile");
                        return;
                      }
                      if (r.label === "通用") {
                        setSubPage("general");
                        return;
                      }
                      if (r.label === "关于") {
                        setSubPage("about");
                        return;
                      }
                      if (r.label === "账号") {
                        setSubPage("account");
                        return;
                      }
                    }}
                  >
                    <span className="wb-modal-row-icon">{r.icon}</span>
                    <span className="wb-modal-row-label">{r.label}</span>
                    {/*
                      声音选择这一行现在显示**实际选中的音色**，不是写死的「温柔桃子」——
                      写死的值会让人以为设置生效了，其实朗读用的是系统默认。
                    */}
                    {r.label === "声音选择" ? (
                      <em data-testid="wb-set-voice-value">{voiceName || "系统默认"}</em>
                    ) : r.value && r.label === "外观" ? (
                      <em data-testid="wb-set-theme-value">{r.value}</em>
                    ) : r.value ? (
                      <em>{r.value}</em>
                    ) : null}
                    <ChevronRight size={13} />
                  </button>
                  {r.label === "记忆" && memoryOpen ? <MemoryPanel /> : null}
                  {r.label === "声音选择" && voiceOpen ? (
                    <div className="wb-voice-list" data-testid="wb-voice-list">
                      {voices.length === 0 ? (
                        <div className="wb-voice-empty">这台机器上没有可选的朗读音色</div>
                      ) : (
                        <>
                          <button
                            className={`wb-voice-item${voiceName ? "" : " is-on"}`}
                            data-testid="wb-voice-default"
                            onClick={() => {
                              saveVoiceName("");
                              setVoiceName("");
                            }}
                          >
                            系统默认
                          </button>
                          {voices.map((v) => (
                            <button
                              className={`wb-voice-item${voiceName === v.name ? " is-on" : ""}`}
                              key={v.name}
                              data-testid={`wb-voice-${v.name}`}
                              onClick={() => {
                                saveVoiceName(v.name);
                                setVoiceName(v.name);
                              }}
                            >
                              {v.name}
                              <em>{v.lang}</em>
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
          </div>
        ))}
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
 * 外壳
 * ============================================================ */

export default function Workbench() {
  const view = useWorkbenchStore((s) => s.view);
  const setView = useWorkbenchStore((s) => s.setView);
  const canvasOpen = useWorkbenchStore((s) => s.canvasOpen);
  const toggleCanvas = useWorkbenchStore((s) => s.toggleCanvas);
  const floatOpen = useWorkbenchStore((s) => s.floatOpen);
  const floatSeed = useWorkbenchStore((s) => s.floatSeed);
  const closeFloat = useWorkbenchStore((s) => s.closeFloat);
  /** 画布内的对话侧栏：默认收起（画布本身就够宽了）。 */
  const [canvasChatOpen, setCanvasChatOpen] = useState(false);

  // 定时任务的调度器（阶段 11.6）：整个应用生命周期只启动一次
  useEffect(() => startScheduler(), []);

  // AI 文档（§153）：启动时读一次磁盘（磁盘是权威）
  useEffect(() => {
    void useDocStore.getState().load();
  }, []);

  // AI 阅读的「最近阅读」（§155）：同样以磁盘为准
  useEffect(() => {
    void useReaderStore.getState().load();
  }, []);

  // 本机 AI 智能体（§156）：同样以磁盘为准
  useEffect(() => {
    void useAgentStore.getState().load();
  }, []);

  // 搜索历史（§162）：同样以磁盘为准
  useEffect(() => {
    void useSearchHistoryStore.getState().load();
  }, []);

  /*
   * 长期记忆（§164）：**必须在开机时读进来** ——
   * 它在请求时直接从 store 里取（`memoryPromptBlock(useMemoryStore.getState().lib)`），
   * 没读就等于没注入。
   */
  useEffect(() => {
    void useMemoryStore.getState().load();
  }, []);

  /*
   * 画布命令的执行端（§146）：挂在根组件上，**不受画布开关影响**。
   * 挂在 CanvasRuntime 里不行 —— 画布关着的时候它根本没挂载，
   * 工具发来的命令就没人接（而"画布没开会自动打开"这件事正需要它先接手）。
   */
  useEffect(() => startCanvasCommandHost(), []);

  /*
   * 左栏那些 ⌘ 角标（Ctrl N / Ctrl Shift T / S / D）以前是**纯装饰** ——
   * 标签画在那儿、按下去什么都不发生。这里把它变成真的（§136）。
   * 键位表与左栏提示**同源**（`shortcuts.ts`），不会再出现"标签改了、绑定没改"。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const to = matchShortcut(e);
      if (!to) return;
      // 认下的组合要拦掉浏览器/系统的默认行为，否则会和默认快捷键打架。
      e.preventDefault();
      setView(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  /*
   * 任务历史 + 本机库的加载顺序**不能反**（阶段 11.9）：
   * 库要拿任务 id 去剔悬空的置顶/项目成员，任务没恢复完就去剔，
   * 会把好数据当悬空项清掉。
   */
  /*
   * 启动读一次本机设置（§183）：`resolveChatRoute()` 是同步读内存的，
   * 不先 load 的话"新对话默认模型"第一次发消息时还没生效。
   */
  useEffect(() => {
    void useAppSettings.getState().load();
  }, []);

  useEffect(() => {
    const stopPersistence = startTaskPersistence();
    void (async () => {
      const taskIds = await restoreTasks();
      await useLibraryStore.getState().load(taskIds);
    })();
    return stopPersistence;
  }, []);

  const body = useMemo(() => {
    switch (view) {
      case "task":
        return <TaskView />;
      case "scheduled":
        return <ScheduledPage />;
      case "plugins":
        return <PluginsPage />;
      case "cloud":
        return <CloudPage />;
      case "phone":
        return <PhonePage />;
      /*
       * 「管理历史对话」—— 对应本体 `chat/thread/list`。
       * 它**不是左栏的一个导航项**（本体左栏没有它），而是从「最近」那一栏进的管理页，
       * 所以不放进 NAV，只在这里接一次。
       */
      case "threads":
        return <ThreadListPage />;
      /*
       * AI 文档（§153）—— 对应本体 `chat/new-doc` / `chat/write`。
       * 与「管理历史对话」一样**不是左栏导航项**：本体是从输入区那个 `+` 里进的
       * （`create_document_button_title` / `doc_create` 都是「新建文档」）。
       */
      case "doc":
        return <DocPanel />;
      /*
       * 任务中心（§154）—— 对应本体 `chat/task-center`。
       * 与「管理历史对话」一样不是左栏导航项，入口在「最近」那一行的头上。
       */
      case "center":
        return <TaskCenterPage />;
      /* AI 阅读（§155）—— 对应本体 `chat/read-web`。 */
      case "reader":
        return <ReaderPanel />;
      /* 创建 AI 智能体（§156）—— 对应本体 `chat/bot/create`。 */
      case "agent":
        return <AgentCreatePanel />;
      /* 创作广场（§159）—— 对应本体 `chat/coding`。 */
      case "coding":
        return <CodingPage />;
      /* 生成图片（§165）—— 对应本体 `chat/create-image`（复用画布的生成面板）。 */
      case "image":
        return <ImageGenPage />;
      /* 生成视频（§174）—— 对应 `chat/create-video`（同一个面板，换成视频那档）。 */
      case "video":
        return <VideoGenPage />;
      default:
        return <HomeView />;
    }
  }, [view]);

  return (
    <div className="wb" data-testid="wb">
      <NavSidebar />
      <main className="wb-main">
        {body}
        {/*
          画布作为**产物面板**开在对话旁边（对标原版形态）。
          之前我们把画布当主界面，那是错的理解 —— 原版里它始终是"任务产物的展示处"。
        */}
        {canvasOpen ? (
          <div className="wb-canvas" data-testid="wb-canvas">
            {/*
              画布与它的对话侧栏一起收在这里。
              保留侧栏是有意的：画布的 AI 生成/改图那套功能挂在它上面（阶段 3/9 验证过），
              拆掉就等于把已验证的功能丢了。默认收起，需要时展开。
            */}
            {canvasChatOpen ? <ChatSidebar /> : null}
            <div className="wb-canvas-stage">
              <button
                className="wb-canvas-chat-toggle"
                data-testid="wb-canvas-chat-toggle"
                title={canvasChatOpen ? "收起画布对话" : "展开画布对话"}
                onClick={() => setCanvasChatOpen((v) => !v)}
              >
                {canvasChatOpen ? "‹" : "›"}
              </button>
              <CanvasRuntime />
            </div>
          </div>
        ) : null}
      </main>
      <SummaryPanel />
      {/* 悬浮助手窗挂应用级：云盘文件行的「问问豆包」也要能调起它 */}
      {floatOpen ? <FloatingAssistant onClose={closeFloat} seed={floatSeed} /> : null}
      <button className="wb-canvas-toggle" data-testid="wb-canvas-toggle" onClick={toggleCanvas} title="显示/隐藏画布">
        {canvasOpen ? "收起画布" : "打开画布"}
      </button>
    </div>
  );
}
