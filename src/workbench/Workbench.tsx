/**

 * 工作台外壳（C6-1 拆过：原来 2188 行 / 14 个顶层组件，现在这里只剩导航、视图切换与这个外壳本身）。

 * 各面板在 `src/workbench/*.tsx`；拆分理由见 `docs/PLAN-C6-结构拆分.md`。

 */

import { useEffect, useMemo, useState } from "react";
import { useWorkbenchStore, restoreTasks, startTaskPersistence } from "./store";
/*
 * ⚠️ C6-2：`pages.tsx` 已按组件拆成 `ScheduledPage.tsx` / `PluginsPage.tsx` / `CloudPage.tsx` / `PhonePage.tsx`
 * （原来那个 1669 行的文件不再存在，避免留一个只是转发的"桶文件"）。
 */
import { CloudPage } from "./CloudPage";
import { PhonePage } from "./PhonePage";
import { PluginsPage } from "./PluginsPage";
import { ScheduledPage } from "./ScheduledPage";
import CanvasRuntime from "@/canvas/CanvasRuntime";
import ChatSidebar from "@/chat/ChatSidebar";
import { startScheduler } from "./scheduleStore";
import { useLibraryStore } from "./libraryStore";
import { matchShortcut } from "./shortcuts";
import { useAppSettings } from "./appSettings";
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
import { startCanvasCommandHost } from "./canvasCommandHost";
import ThreadListPage from "./ThreadListPage";
import FloatingAssistant from "./FloatingAssistant";

import { NavSidebar } from "./NavSidebar";
import { TaskView } from "./TaskView";
import { HomeView } from "./HomeView";
import { SummaryPanel } from "./SummaryPanel";

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

