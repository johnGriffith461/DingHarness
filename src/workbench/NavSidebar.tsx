/**
 * 从 `Workbench.tsx` 拆出来的（C6-1）。**纯挪位**：一个字没改，只加了 export 与 import。
 * 拆的理由原本记在 `docs/PLAN-C6-结构拆分.md`：那个文件 2188 行、14 个顶层组件，
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 改一处要读两千行 —— 于是「顺手加一行」变成默认做法。
 */

import { useEffect, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Clock,
  FolderInput,
  FolderMinus,
  ListTodo,
  Minus,
  Pencil,
  Pin,
  Wrench,
  Terminal,
  ShieldCheck,
  Settings,
  Workflow,
  X,
} from "lucide-react";
import { useWorkbenchStore, type WorkbenchView } from "./store";
import { navCollapsedNow, startNavCollapsedSync, useAppSettings } from "./appSettings";
import { type WorkTask } from "./task";
import { useLibraryStore } from "./libraryStore";
import { startTheme } from "./theme";
import { shortcutFor } from "./shortcuts";
import AccountMenu from "./AccountMenu";
import ContextMenu, { clampMenu } from "./ContextMenu";
import { BrandMark } from "./brandMark";
import { NavSearch } from "./NavSearch";

import { setNoteIfAny } from "./uiUtil";
import { SettingsDialog } from "./SettingsDialog";


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

export const NAV: Array<{ view: WorkbenchView; label: string; icon: typeof ListTodo }> = [
  { view: "home", label: "新工作任务", icon: ListTodo },
  { view: "scheduled", label: "定时任务", icon: Clock },
  /* C-01：「手机遥控电脑」移入设置 —— 本机不可用，不该占主导航。 */
  /* V6-2c/2d：用量与请求追踪（原来只有单会话弹层，没有跨会话的页） */
  { view: "usage", label: "用量与追踪", icon: Activity },
  /* V6-2i/4d：两轴权限矩阵（内核早就有判定，缺的是能看的那张表） */
  { view: "permissions", label: "权限矩阵", icon: ShieldCheck },
  /* V6-2l：多 agent 工作流（泳道 + 断点续跑命令） */
  { view: "workflow", label: "工作流", icon: Workflow },
  /* D2：工具面板（模型够得着什么、怎么调度） */
  { view: "tools", label: "工具", icon: Wrench },
  /* F4：终端（只读回放） */
  { view: "terminal", label: "终端", icon: Terminal },
];

/** 每秒重算一次"已处理 N 秒"。 */

export function useTick(active: boolean): number {
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

export function NavSidebar() {
  const view = useWorkbenchStore((s) => s.view);
  const tasks = useWorkbenchStore((s) => s.tasks);
  const activeId = useWorkbenchStore((s) => s.activeTaskId);
  const setView = useWorkbenchStore((s) => s.setView);
  const openTask = useWorkbenchStore((s) => s.openTask);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * F-03：从别处直接打开某个设置子页（例如任务页的「去选模型」）。
   * `null` = 设置主列表（原来的行为）。
   */
  const [settingsPage, setSettingsPage] = useState<import("./SettingsPages").SettingsSubPage | null>(null);
  /* 输入区的「管理模型」要能打开设置（见 Composer 那处说明） */
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: import("./SettingsPages").SettingsSubPage }>).detail;
      setSettingsPage(detail?.page ?? null);
      setSettingsOpen(true);
    };
    window.addEventListener("dsh-open-settings", onOpen);
    return () => window.removeEventListener("dsh-open-settings", onOpen);
  }, []);
  /** 左栏收起（工单 3）：状态在 store 里，六个页面的那颗按钮共用一个开关。 */
  const navCollapsed = useWorkbenchStore((s) => s.navCollapsed);
  /* L06：订阅键位表 —— 设置里改完，左栏的提示立刻跟着变 */
  const keymap = useAppSettings((s) => s.keymap);
  /*
   * ⭐ 收起态要**跨重启记住**（2026-10-16，审计 P187 / P191）。
   *
   * 界面状态在 `store.ts`（上面那一行读它、`NavCollapseButton` 切它），
   * 「记住它」在应用设置里（走主进程落盘）—— 这里只把两边接起来。
   * 为什么不是把字段整个搬到设置里、或者让 store 自己去写盘：
   * 三个理由（两种家、灌盘的时机、失败回滚）都写在 `appSettings.ts` 的
   * `startNavCollapsedSync` 上，一处说清，这里不重述。
   *
   * ⚠️ `read` 拿的是 `useAppSettings` 里那份**内存缓存**（`load()` 已经填好），
   * 所以这里不需要 await 一趟 IPC —— 灌盘发生在 `loaded` 那一刻。
   */
  useEffect(
    () =>
      startNavCollapsedSync({
        read: navCollapsedNow,
        apply: (saved) => useWorkbenchStore.setState({ navCollapsed: saved }),
        subscribe: (onChange) =>
          useWorkbenchStore.subscribe((state, prev) => {
            if (state.navCollapsed !== prev.navCollapsed) onChange(state.navCollapsed);
          }),
      }),
    [],
  );
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
    <aside className={`wb-nav${navCollapsed ? " is-collapsed" : ""}`} data-testid="wb-nav">
      {/*
        ⚠️ 2026-10-17（V5 开工前清尾 §2.4）：这里原来还有「后退」「前进」两颗
        **永久禁用**的浏览器式按钮（"仿浏览器工具条"）。Ding 不是浏览器 ——
        历史导航这个概念在左栏+画布的结构里不成立，处置是**移除**（不是留灰）。
        「搜索」那颗留下了：它从装饰变成了真检索（`NavSearch`，走 Phase 12.4 的会话检索）。
      */}
      <div className="wb-nav-head">
        <BrandMark />
        <NavSearch />
      </div>

      <nav className="wb-nav-list">
        {NAV.map((item) => {
          const Icon = item.icon;
          const on = view === item.view || (item.view === "home" && view === "task");
          /* L06：提示文本从当前键位表来 —— 改完键位立刻反映，不会写着旧的 */
          const shortcut = shortcutFor(item.view, keymap);
          return (
            <button
              key={item.view}
              className={`wb-nav-item${on ? " is-on" : ""}`}
              data-testid={`wb-nav-${item.view}`}
              onClick={() => setView(item.view)}
            >
              <Icon size={15} />
              <span>{item.label}</span>
              {shortcut ? <em className="wb-kbd">{shortcut}</em> : null}
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
                  <span className="wb-nav-mini" aria-hidden>
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                  <span className="wb-nav-row-title">{project.name}</span>
                  <em className="wb-nav-count">{project.memberIds.length}</em>
                  {/*
                    ⚠️ 这三个原来都是**可点的 `<span>`**（2026-10-14 改成真按钮）：
                    键盘够不着、读屏念不出，而且用「✎ × −」这几个字符当图标
                    （与全站的 lucide 不一致 —— `best-practices` 那条"图标来自图标库"）。
                  */}
                  <button
                    className="wb-nav-mini"
                    type="button"
                    aria-label="重命名项目"
                    title="重命名"
                    data-testid={`wb-project-rename-${project.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const name = window.prompt("重命名项目", project.name);
                      if (name) rename(project.id, name);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    className="wb-nav-mini"
                    type="button"
                    aria-label="删除项目"
                    title="删除项目（里面的任务不会被删）"
                    data-testid={`wb-project-del-${project.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      dropProject(project.id);
                    }}
                  >
                    <X size={12} />
                  </button>
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
                        <button
                          className="wb-nav-mini"
                          type="button"
                          aria-label="移出项目"
                          title="移出项目"
                          onClick={(e) => {
                            e.stopPropagation();
                            assignProject(null, id);
                          }}
                        >
                          <Minus size={12} />
                        </button>
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
          <b>本机用户</b>
          <em>本机模式</em>
        </span>
        <Settings size={14} />
      </button>

      {accountMenuOpen ? (
        <AccountMenu
          onClose={() => setAccountMenuOpen(false)}
          onOpenSettings={() => {
            setSettingsPage(null);
            setSettingsOpen(true);
          }}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsDialog
          initialPage={settingsPage ?? undefined}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

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
              icon: <Pin size={13} />,
              run: () => pin(rowMenu.task.id),
            },
            {
              label: "重命名",
              icon: <Pencil size={13} />,
              run: () => {
                const name = window.prompt("重命名任务", rowMenu.task.title);
                if (name) renameTask(rowMenu.task.id, name);
              },
            },
            ...(lib.projects.length > 0
              ? lib.projects.map((p) => ({
                  label: `归入「${p.name}」`,
                  icon: <FolderInput size={13} />,
                  run: () => assignProject(p.id, rowMenu.task.id),
                }))
              : []),
            ...(lib.projects.some((p) => p.memberIds.includes(rowMenu.task.id))
              ? [{ label: "移出项目", icon: <FolderMinus size={13} />, run: () => assignProject(null, rowMenu.task.id) }]
              : []),
            {
              label: "移除",
              icon: <Minus size={13} />,
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
