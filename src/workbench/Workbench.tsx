/**

 * 工作台外壳（C6-1 拆过：原来 2188 行 / 14 个顶层组件，现在这里只剩导航、视图切换与这个外壳本身）。

 * 各面板在 `src/workbench/*.tsx`；拆分理由原本记在 `docs/PLAN-C6-结构拆分.md`。
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）

 */

/*
 * ⚠️ **非首屏页面一律懒加载**（T2 启动实测，2026-10-19）。
 *
 * 原来这里有 13 个页面是**同步 import** —— 用户打开应用时，
 * 电话 / 插件 / 定时 / 观测 / 权限矩阵 / 工作流 / 文档 / 任务中心 / 阅读 /
 * 智能体 / 创作广场 / 图 / 视频 这些页面的代码**全部被解析并执行**，
 * 而首屏只用到 HomeView。实测：首帧之后还要 ~1.2s 才渲染出工作台（目标 1.5s 总时长）。
 *
 * 改成 lazy 之后，切到那一页时才拉它的 chunk；首屏只付首页的代价。
 */
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useWorkbenchStore, restoreTasks, startTaskPersistence } from "./store";
/*
 * ⚠️ C6-2：`pages.tsx` 已按组件拆成 `ScheduledPage.tsx` / `PluginsPage.tsx` / `PhonePage.tsx`
 * （原来那个 1669 行的文件不再存在，避免留一个只是转发的"桶文件"）。
 */
const PhonePage = lazy(() => import("./PhonePage").then((m) => ({ default: m.PhonePage })));
const PluginsPage = lazy(() => import("./PluginsPage").then((m) => ({ default: m.PluginsPage })));
const ScheduledPage = lazy(() => import("./ScheduledPage").then((m) => ({ default: m.ScheduledPage })));
const InsightsPage = lazy(() => import("./InsightsPage").then((m) => ({ default: m.InsightsPage })));
const PermissionMatrixPage = lazy(() => import("./PermissionMatrixPage").then((m) => ({ default: m.PermissionMatrixPage })));
const ToolsPage = lazy(() => import("./ToolsPage").then((m) => ({ default: m.ToolsPage })));
const TerminalPanel = lazy(() => import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
const WorkflowPage = lazy(() => import("./WorkflowPage").then((m) => ({ default: m.WorkflowPage })));
/*
 * D06（2026-10-18）：画布**懒加载**。
 *
 * 在这之前 `CanvasRuntime` 是静态 import —— 即使 `canvasOpen` 是 false，
 * `@xyflow/react` 与它的 CSS 也会在首屏被下载/执行。用户没打开画布也要付这份启动成本
 * （产品审计量到桌面可操作 3540ms）。现在它只在一个动态 chunk 里。
 */
const CanvasRuntime = lazy(() => import("@/canvas/CanvasRuntimeHost"));
import { startScheduler } from "./scheduleStore";
import { useLibraryStore } from "./libraryStore";
import { matchShortcut } from "./shortcuts";
import { escYieldsToOverlay } from "./escOverlays";
import { keymapNow, useAppSettings } from "./appSettings";
import { matchKeyAction } from "@shared/keymap";
const DocPanel = lazy(() => import("./DocPanel").then((m) => ({ default: m.DocPanel })));
const TaskCenterPage = lazy(() => import("./TaskCenterPage").then((m) => ({ default: m.TaskCenterPage })));
const ReaderPanel = lazy(() => import("./ReaderPanel").then((m) => ({ default: m.ReaderPanel })));
const AgentCreatePanel = lazy(() => import("./AgentCreatePanel").then((m) => ({ default: m.AgentCreatePanel })));
const CodingPage = lazy(() => import("./CodingPage").then((m) => ({ default: m.CodingPage })));
const ImageGenPage = lazy(() => import("./ImageGenPage").then((m) => ({ default: m.ImageGenPage })));
const VideoGenPage = lazy(() => import("./VideoGenPage").then((m) => ({ default: m.VideoGenPage })));
import { useAgentStore } from "./agentStore";
import { useSearchHistoryStore } from "./searchHistoryStore";
import { useMemoryStore } from "./memoryStore";
import { useReaderStore } from "./readerStore";
import { useDocStore } from "./docStore";
import { startCanvasCommandHost } from "./canvasCommandHost";
import { DiagnosticsDialog } from "./DiagnosticsDialog";
import { ConfirmHost } from "./ConfirmHost";
import ThreadListPage from "./ThreadListPage";
import FloatingAssistant from "./FloatingAssistant";
import TitleBar from "./TitleBar";

import { NavSidebar } from "./NavSidebar";
import { TaskView } from "./TaskView";
import { HomeView } from "./HomeView";
import { FirstRunGuide, useFirstRunVisibility } from "./FirstRunGuide";
import { CommandPalette } from "./CommandPalette";
import { SummaryPanel } from "./SummaryPanel";

export default function Workbench() {
  const view = useWorkbenchStore((s) => s.view);
  const setView = useWorkbenchStore((s) => s.setView);
  const canvasOpen = useWorkbenchStore((s) => s.canvasOpen);
  const floatOpen = useWorkbenchStore((s) => s.floatOpen);
  const floatSeed = useWorkbenchStore((s) => s.floatSeed);
  const closeFloat = useWorkbenchStore((s) => s.closeFloat);
  /*
   * 右侧「对话摘要」的收起态**提在这里**（2026-10-15，M0 工单 2）。
   *
   * 原来它是 `SummaryPanel` 内部的 `useState`。提上来是为了让 **Esc 只由一处处理**：
   * 两个右侧面板各自的开关都在这里，Esc 的语义才说得清（不然两个监听器同时响应，
   * 一次 Esc 会把两个面板一起关掉，或者按注册顺序决定关哪个 —— 都不是用户能预期的）。
   * 仓库里同样的取舍见 `theme.ts`（"改主题的唯一收口"）。
   */
  const [summaryCollapsed, setSummaryCollapsed] = useState(true);
  /* G13：命令面板（Ctrl/Cmd+K） */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /*
   * F-01（2026-10-20）：首屏只留**一个主动作**。
   *
   * 原来向导与首页上下并列，首屏 31 个可点元素在两个主动作之间抢注意力；
   * 现在向导显示期间首页主体不渲染 —— 用户只需要决定"配不配、怎么配"。
   */
  const firstRun = useFirstRunVisibility();

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
      /*
       * ⚠️ **焦点在输入框里时，导航快捷键不许抢**（2026-10-16，审计 P84）。
       *
       * 这一段原来一行 `target` 判定都没有（下面处理 Esc 的那段有，于是它看着像已经处理了）。
       * 后果：在输入框里写着东西、顺手按 Ctrl+N / Ctrl+Shift+T，**页面直接切走、草稿整段丢**。
       * 判据与 Esc 那段保持一致：INPUT / TEXTAREA / contentEditable 一律让开
       * （这两个组合在文本框里没有编辑含义，让开就是"不打断打字、也不切页"）。
       *
       * 注：草稿本身也已经搬到 store（按视图分开存，见 `composerDraft.ts`）——
       * 两道一起上：打字时不该被抢，真切走了回来也还在。
       */
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      /* L06：导航键位来自可自定义的键位表（默认 Ctrl N / Ctrl Shift T） */
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
   * **命令面板的键位**（G13 / L06）：默认 Ctrl/Cmd+K，可自定义。
   *
   * 它在输入框里也要能按 —— 那正是"随手跳走"的用法（导航快捷键那条"输入框里让开"
   * 的规矩不适用于它）。绑定来自 `@shared/keymap`，与设置页录制的是同一份。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchKeyAction(e, keymapNow()) !== "palette") return;
      e.preventDefault();
      setPaletteOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /*
   * Esc 收起右侧面板（2026-10-15，M0 工单 2）。
   *
   * 两个面板**都要键盘可达** —— 用户报过"打开了然后怎么关呢"，而关的入口本来只有一颗
   * 贴在边缘的小把手。Esc 是泛用约定，但有三条边界必须让开，否则修 bug 会修出新 bug：
   *
   *   ① 浮层开着时不动面板：那些浮层**自己处理 Esc**，两头一起关会让人莫名其妙
   *      （2026-10-16 审计 P107：这一条原来只认 `.wb-modal-mask` 那一个死选择器，
   *      于是技能面板 / 各类右键菜单 / 账号菜单开着时，Esc **两头一起关**。
   *      名单见 `escOverlays.ts`，那里也说明了为什么留 `.wb-modal-mask`）；
   *   ② 焦点在输入框里时不动面板：画布对话侧栏一关就**卸载**，正在写的草稿会直接没了；
   *   ③ 一次只关一个 —— 所以状态都提在上面，这里只有一处判定，
   *      不会两个监听器抢同一次按键。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escYieldsToOverlay((selector) => Boolean(document.querySelector(selector)))) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      /* ⚠️ 2026-10-16：这里原来还有一条「画布对话优先收」，画布那个聊天侧栏拆了 —— 那条随之消失。 */
      if (!summaryCollapsed) setSummaryCollapsed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [summaryCollapsed]);

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
      /* V6-2c/2d：用量与请求追踪（只读派生数据） */
      case "usage":
        return <InsightsPage />;
      /* V6-2i/4d：两轴权限矩阵（只读展示内核判定） */
      case "permissions":
        return <PermissionMatrixPage />;
      case "tools":
        return <ToolsPage />;
      case "terminal":
        return <TerminalPanel />;
      /* V6-2l：工作流泳道与断点续跑（运行在 CLI） */
      case "workflow":
        return <WorkflowPage />;
      case "plugins":
        return <PluginsPage />;
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
        return (
          /*
           * ⚠️ 首跑向导与首页必须是**上下**关系，不能并排。
           * `.wb-main` 是 `display:flex`（横排）—— 直接放两个兄弟的话，
           * 向导会变成一列（620px）、首页被挤成窄条，画布也被压到右边缘；
           * 而且向导卡默认 `align-items:stretch`，会被拉成全高。
           * 外面这一层 `wb-home-shell` 把它们收成同一列。
           */
          <div className="wb-home-shell" data-testid="wb-home-shell">
            {/*
              U06 + F-01：没配好时**只**显示向导（不再与首页并列）。
              `ready:false` 是"设置/通道还没读完"——先留白一瞬，
              免得首页先闪出来又被向导盖住（那一下正是"两个主动作"的观感来源）。
            */}
            {!firstRun.ready ? null : firstRun.visible ? <FirstRunGuide /> : <HomeView />}
          </div>
        );
    }
  }, [view, firstRun.ready, firstRun.visible]);

  return (
    <div className="wb" data-testid="wb">
      {/* 标题栏（窗口按钮 + 拖动区）—— 必须是 `.wb` 的第一个孩子且独占一行，理由见 TitleBar.tsx */}
      <TitleBar />
      <NavSidebar />
      <main className="wb-main">
        {/* 懒加载的页面要一个 Suspense 边界：切页时先显示占位，不白屏 */}
        <Suspense fallback={<div className="wb-canvas-loading">正在打开…</div>}>{body}</Suspense>
        {/*
          画布作为**产物面板**开在对话旁边（对标原版形态）。
          之前我们把画布当主界面，那是错的理解 —— 原版里它始终是"任务产物的展示处"。
        */}
        {canvasOpen ? (
          <div className="wb-canvas" data-testid="wb-canvas">
            {/*
              ⚠️ 2026-10-16：画布自带的那条对话侧栏（连它那颗 `‹` 把手）**拆了** ——
              主人的话：「应该用咱们主界面里边这个 Agent 的这个模型 去使用右边的这个画布啊
              为什么你还有个聊天」。画布要 AI 干活走它自己的工具条（顶部「AI 生成」、
              底部「图片 / 视频生成」）；而"让 agent 操作画布"是主界面那条路 ——
              agent 手上就有 `canvas_add_node`（`canvasCommandHost.ts`）。
            */}
            <div className="wb-canvas-stage">
              <Suspense fallback={<div className="wb-canvas-loading">正在打开画布…</div>}>
                <CanvasRuntime />
              </Suspense>
            </div>
          </div>
        ) : null}
      </main>
      {/* 收起态由工作台持有（Esc 只在这一处判定，见上面的 Esc 处理） */}
      <SummaryPanel collapsed={summaryCollapsed} onCollapsedChange={setSummaryCollapsed} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {/* CUA 确认框（2026-10-19：不再用系统原生弹窗） */}
      <ConfirmHost />
      {/* G17：诊断包预览（「反馈」与命令面板都通过事件打开它） */}
      <DiagnosticsDialog />
      {/* 悬浮助手窗挂应用级：云盘文件行的「问问豆包」也要能调起它 */}
      {floatOpen ? <FloatingAssistant onClose={closeFloat} seed={floatSeed} /> : null}
      {/*
        ⚠️ 右下角那颗浮动「打开画布」**撤掉了**（2026-10-14，主人的话：
        「那个打开画布 你不要放在右下角干嘛呀 人家豆包工作人是放在这个技能里面的」）。
        入口改到技能面板的「创建画布」那一条 —— 本体截图里的命令区本来就有它。
      */}
    </div>
  );
}

