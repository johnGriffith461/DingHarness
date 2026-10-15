import { contextBridge, ipcRenderer } from "electron";
import type { AiStreamEvent, CanvasCommand, SessionSummary, ShellBridge } from "../shared/ipc";
import { AI_CHANNEL } from "./ipc/ai";
import { CLIPBOARD_CHANNEL } from "./ipc/clipboard";
import { CODING_CHANNEL } from "./ipc/codingStore";
import { APP_SETTINGS_CHANNEL } from "./ipc/appSettings";
import { SESSION_CHANNEL } from "./ipc/sessionStore";
import { PLUGIN_CHANNEL } from "./ipc/pluginHost";
import { CANVAS_CHANNEL } from "./ipc/canvas";
import { CANVAS_EXPORT_CHANNEL } from "./ipc/canvasExport";
import { ARTIFACT_CHANNEL } from "./ipc/artifactStore";
import { DRIVE_CHANNEL } from "./ipc/driveStore";
import { SCHEDULE_CHANNEL } from "./ipc/scheduleStore";
import { MEMORY_CHANNEL } from "./ipc/memoryStore";
import { LIBRARY_CHANNEL } from "./ipc/libraryStore";
import { DOC_CHANNEL } from "./ipc/docStore";
import { READER_CHANNEL } from "./ipc/readerStore";
import { AGENT_CHANNEL } from "./ipc/agentStore";
import { SEARCH_HISTORY_CHANNEL } from "./ipc/searchStore";
import { WORKSPACE_CHANNEL } from "./ipc/workspaceStore";
import { MCP_CHANNEL } from "./ipc/mcpStore";
import { TASK_CHANNEL } from "./ipc/taskStore";
import { VIDEO_CHANNEL } from "./ipc/videoGen";
import { REMOTE_CHANNEL } from "./ipc/remote";
import { IMAGE_CHANNEL } from "./ipc/imageGen";

/**
 * 渲染进程唯一的 Node 能力入口。
 * 原则：只暴露**具名、窄接口**，不暴露 ipcRenderer 本体。
 *
 * AI 相关的通道在这里绑死；密钥永远在主进程，渲染进程拿不到明文。
 * 后续阶段（文件/数据库/快照）都在这里加方法，并同步 `shared/ipc.ts` 的类型。
 */

/**
 * ⚠️ **`satisfies ShellBridge`（C4）**：这句话就是"契约只有一份"的落点。
 *
 * 在这之前，`shared/ipc.ts` 的 `ShellBridge` 与这里的 `api` 是**两份手写形状**，
 * 已经漂移过（`ShellBridge` 缺 `memory`/`setTitlebar`，`src/workbench/memoryStore.ts`
 * 只好自己打补丁扩展类型）。漂移不会有任何报错 —— 只会表现为"渲染层调了一个不存在的方法"
 * 或者"类型说有、实际没有"。
 *
 * 加上 `satisfies` 之后：**这里少一个字段、多一个字段、签名差一点，`tsc` 立刻报错**。
 * 契约的唯一事实来源是 `ShellBridge`，实现必须与它一致。
 */
const api = {
  ping: () => ipcRenderer.invoke("app:ping"),
  /**
   * 让窗口标题栏覆盖层跟随主题。
   *
   * @param payload 覆盖层底色与符号色
   */
  setTitlebar: (payload: { color: string; symbolColor: string }): Promise<boolean> =>
    ipcRenderer.invoke("app:titlebar", payload),
  userDataDir: (): Promise<string> => ipcRenderer.invoke("app:userDataDir"),

  ai: {
    /** 列出可用 provider（脱敏，只含 id/名称/模型/是否可用）。 */
    listProviders: () => ipcRenderer.invoke(AI_CHANNEL.listProviders),
    /** 发起一次流式对话，返回 requestId；后续片段从 onStream 里按 id 归并。 */
    chat: (request: unknown) => ipcRenderer.invoke(AI_CHANNEL.chat, request),
    /** 中止某个请求。 */
    abort: (requestId: string) => ipcRenderer.invoke(AI_CHANNEL.abort, requestId),
    /**
     * 订阅流事件。
     * @param listener 收到事件时调用
     * @returns 取消订阅函数
     */
    onStream: (listener: (event: AiStreamEvent) => void): (() => void) => {
      /*
       * ⚠️ 参数类型写成**契约里的真实类型**（`AiStreamEvent`），不是 `unknown`。
       * 写成 `unknown` 时 `satisfies ShellBridge` 会报错（C4 照出来的第二处漂移）：
       * 契约说"监听器收 AiStreamEvent"，实现却只承诺"我什么类型都收" ——
       * 方向反了（函数参数是逆变的）。运行时载荷就来自主进程，那个通道发什么类型是确定的。
       */
      const wrapped = (_e: unknown, payload: unknown) => listener(payload as AiStreamEvent);
      ipcRenderer.on(AI_CHANNEL.stream, wrapped);
      /*
       * ⚠️ 箭头函数体里**先调再返回 undefined**：`removeListener` 返回的是 `IpcRenderer` 自己，
       * 而契约要求"取消订阅函数"返回 `void` —— 直接把它的返回值交出去会让
       * `satisfies ShellBridge` 报错（C4 就是这么把漂移照出来的）。
       */
      return () => {
        ipcRenderer.removeListener(AI_CHANNEL.stream, wrapped);
      };
    },
    /** 主动探测各 provider 真实连通性（不在启动时自动跑）。 */
    probe: () => ipcRenderer.invoke(AI_CHANNEL.probe),
    /** 用户放行后执行一次被拦下的工具调用（§144）。 */
    runTool: (request: unknown) => ipcRenderer.invoke(AI_CHANNEL.runTool, request),
  },
  canvas: {
    /** 载入画布文档（含崩溃回退信息）。 */
    load: () => ipcRenderer.invoke(CANVAS_CHANNEL.load),
    /** 保存快照（主进程原子写）。 */
    save: (doc: unknown) => ipcRenderer.invoke(CANVAS_CHANNEL.save, doc),
    /** 确认某个修订已落盘（ack）。 */
    ack: (revision: number) => ipcRenderer.invoke(CANVAS_CHANNEL.ack, revision),
    /** 快照状态摘要（已保存 / 未确认）。 */
    status: () => ipcRenderer.invoke(CANVAS_CHANNEL.status),
    /** 历史快照列表。 */
    revisions: () => ipcRenderer.invoke(CANVAS_CHANNEL.revisions),
    /** 读某个历史版本（预览用）。 */
    readRevision: (revision: number) => ipcRenderer.invoke(CANVAS_CHANNEL.readRevision, revision),
    /** 回滚到某个历史版本。 */
    restore: (revision: number) => ipcRenderer.invoke(CANVAS_CHANNEL.restore, revision),
    /** 导出 PNG（截取画布上的一块区域，落盘后返回路径）。 */
    exportPng: (request: { rect: { x: number; y: number; width: number; height: number }; name?: string }) =>
      ipcRenderer.invoke(CANVAS_EXPORT_CHANNEL.exportPng, request),
    /** 打开导出目录。 */
    revealExports: () => ipcRenderer.invoke(CANVAS_EXPORT_CHANNEL.revealExports),
    /**
     * 订阅主进程发来的画布命令（§146）。
     *
     * 为什么是"主进程发命令、渲染进程动手"：画布文档由**渲染进程持有**，
     * 主进程直接写会被渲染侧的自动保存覆盖掉。
     *
     * @param listener 收到命令时调（执行完要调 commandResult 回执）
     * @returns 取消订阅
     */
    onCommand: (listener: (cmd: CanvasCommand) => void): (() => void) => {
      /* 同上：按契约的真实类型标注（不是 unknown） */
      const wrapped = (_e: unknown, payload: unknown) => listener(payload as CanvasCommand);
      ipcRenderer.on(CANVAS_CHANNEL.command, wrapped);
      /* 同上：取消订阅只该返回 void，不要把手里的 IpcRenderer 漏出去 */
      return () => {
        ipcRenderer.removeListener(CANVAS_CHANNEL.command, wrapped);
      };
    },
    /** 执行完回执给主进程（工具那边在等）。 */
    commandResult: (result: unknown) => ipcRenderer.invoke(CANVAS_CHANNEL.commandResult, result),
  },
  image: {
    /** 列出可用的图像模型（只列真的配了密钥的）。 */
    listModels: () => ipcRenderer.invoke(IMAGE_CHANNEL.listModels),
    /** 生成一张图，落盘后返回文件名与可直链的 url。 */
    generate: (request: { prompt: string; model?: string; size?: string }) =>
      ipcRenderer.invoke(IMAGE_CHANNEL.generate, request),
    /** 以一张已有图为输入做编辑（图生图）。 */
    edit: (request: { source: string; prompt: string; model?: string; size?: string }) =>
      ipcRenderer.invoke(IMAGE_CHANNEL.edit, request),
  },
  plugins: {
    list: () => ipcRenderer.invoke(PLUGIN_CHANNEL.list),
    install: () => ipcRenderer.invoke(PLUGIN_CHANNEL.install),
    setEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke(PLUGIN_CHANNEL.setEnabled, name, enabled),
    uninstall: (name: string) => ipcRenderer.invoke(PLUGIN_CHANNEL.uninstall, name),
    doctor: () => ipcRenderer.invoke(PLUGIN_CHANNEL.doctor),
  },
  remote: {
    /** 读本机侧状态：许可 + 是否正在阻止休眠。 */
    status: () => ipcRenderer.invoke(REMOTE_CHANNEL.status),
    /** 开关"保持唤醒"（主进程真的调 powerSaveBlocker）。返回操作后的状态。 */
    setKeepAwake: (on: boolean) => ipcRenderer.invoke(REMOTE_CHANNEL.setKeepAwake, on),
    /** 开关"可被同账号设备连接与控制"（写盘）。 */
    setAllowConnect: (on: boolean) => ipcRenderer.invoke(REMOTE_CHANNEL.setAllowConnect, on),
  },
  video: {
    /** 列出可用的视频模型（没有就返回空数组）。 */
    listModels: () => ipcRenderer.invoke(VIDEO_CHANNEL.listModels),
    /** 提交一次视频生成并等成品落盘。 */
    generate: (prompt: string, model?: string) => ipcRenderer.invoke(VIDEO_CHANNEL.generate, prompt, model),
  },
  tasks: {
    /** 读工作台任务（重启后恢复历史）。 */
    load: () => ipcRenderer.invoke(TASK_CHANNEL.load),
    /** 写工作台任务（原子写）。 */
    save: (tasks: unknown) => ipcRenderer.invoke(TASK_CHANNEL.save, tasks),
  },
  library: {
    /** 读本机库（装过的插件 / 项目 / 置顶 / 收藏）。 */
    load: () => ipcRenderer.invoke(LIBRARY_CHANNEL.load),
    /** 写本机库（原子写）。收窄在渲染层做，主进程只存字节。 */
    save: (value: unknown) => ipcRenderer.invoke(LIBRARY_CHANNEL.save, value),
  },
  /** AI 文档（§153）。 */
  docs: {
    load: () => ipcRenderer.invoke(DOC_CHANNEL.load),
    save: (docs: unknown) => ipcRenderer.invoke(DOC_CHANNEL.save, docs),
  },
  /** AI 阅读的「最近阅读」（§155）。 */
  readings: {
    load: () => ipcRenderer.invoke(READER_CHANNEL.load),
    save: (readings: unknown) => ipcRenderer.invoke(READER_CHANNEL.save, readings),
  },
  /** 本机 AI 智能体（§156）。 */
  agents: {
    load: () => ipcRenderer.invoke(AGENT_CHANNEL.load),
    save: (agents: unknown) => ipcRenderer.invoke(AGENT_CHANNEL.save, agents),
  },
  /** 搜索历史（§162）。 */
  searchHistory: {
    load: () => ipcRenderer.invoke(SEARCH_HISTORY_CHANNEL.load),
    save: (history: unknown) => ipcRenderer.invoke(SEARCH_HISTORY_CHANNEL.save, history),
  },
  /** 连接器（MCP，2026-10-14）。 */
  mcp: {
    list: () => ipcRenderer.invoke(MCP_CHANNEL.list),
    reload: () => ipcRenderer.invoke(MCP_CHANNEL.reload),
    openConfig: () => ipcRenderer.invoke(MCP_CHANNEL.openConfig),
  },
  /** 工作区（2026-10-14）：授权给 agent 干活的目录。 */
  workspace: {
    list: () => ipcRenderer.invoke(WORKSPACE_CHANNEL.list),
    add: () => ipcRenderer.invoke(WORKSPACE_CHANNEL.add),
    remove: (dir: string) => ipcRenderer.invoke(WORKSPACE_CHANNEL.remove, dir),
  },
  schedules: {
    /** 读定时任务（重启后恢复）。 */
    load: () => ipcRenderer.invoke(SCHEDULE_CHANNEL.load),
    /** 写定时任务（原子写）。 */
    save: (jobs: unknown) => ipcRenderer.invoke(SCHEDULE_CHANNEL.save, jobs),
    /**
     * 主进程改了任务时收到通知（§145）。
     * @param listener 收到时调
     * @returns 取消订阅
     */
    onChanged: (listener: () => void) => {
      const wrapped = () => listener();
      ipcRenderer.on(SCHEDULE_CHANNEL.changed, wrapped);
      return () => ipcRenderer.removeListener(SCHEDULE_CHANNEL.changed, wrapped);
    },
  },
  /** 记忆的读 / 写 / 清空。 */
  memory: {
    read: (): Promise<unknown> => ipcRenderer.invoke(MEMORY_CHANNEL.read),
    write: (lib: unknown): Promise<unknown> => ipcRenderer.invoke(MEMORY_CHANNEL.write, lib),
    clear: (): Promise<unknown> => ipcRenderer.invoke(MEMORY_CHANNEL.clear),
  },
  appSettings: {
    read: (): Promise<{ pinnedModel: string }> => ipcRenderer.invoke(APP_SETTINGS_CHANNEL.read),
    write: (next: { pinnedModel: string }): Promise<{ pinnedModel: string }> =>
      ipcRenderer.invoke(APP_SETTINGS_CHANNEL.write, next),
  },
  coding: {
    loadLiked: (): Promise<string[]> => ipcRenderer.invoke(CODING_CHANNEL.read),
    saveLiked: (liked: string[]): Promise<boolean> => ipcRenderer.invoke(CODING_CHANNEL.write, liked),
  },
  clipboard: {
    read: (): Promise<string> => ipcRenderer.invoke(CLIPBOARD_CHANNEL.read),
    write: (text: string): Promise<boolean> => ipcRenderer.invoke(CLIPBOARD_CHANNEL.write, text),
  },
  drive: {
    /** 列出云盘里的文件（产物 / 导出 / 云盘本体三个来源）。 */
    list: () => ipcRenderer.invoke(DRIVE_CHANNEL.list),
    /** 弹系统文件选择框导入到云盘。 */
    importFiles: () => ipcRenderer.invoke(DRIVE_CHANNEL.import),
    importPaths: (paths: string[]) => ipcRenderer.invoke(DRIVE_CHANNEL.importPaths, paths),
    importData: (items: Array<{ name: string; data: Uint8Array }>) =>
      ipcRenderer.invoke(DRIVE_CHANNEL.importData, items),
    /** 从云盘删除（只允许删自己三个目录里的）。 */
    remove: (filePath: string): Promise<boolean> => ipcRenderer.invoke(DRIVE_CHANNEL.remove, filePath),
    /** 在文件管理器里定位。 */
    reveal: (filePath: string): Promise<boolean> => ipcRenderer.invoke(DRIVE_CHANNEL.reveal, filePath),
    /** 用系统默认程序打开。返回空串表示成功。 */
    open: (filePath: string): Promise<string> => ipcRenderer.invoke(DRIVE_CHANNEL.open, filePath),
    /** 创建副本（同目录、名字加「-副本」）。返回新文件名或 null。 */
    duplicate: (filePath: string): Promise<string | null> => ipcRenderer.invoke(DRIVE_CHANNEL.duplicate, filePath),
    /** 新建一个文本文件（对标云盘「＋新建」）。返回新文件名或 null。 */
    create: (name: string, content = ""): Promise<string | null> =>
      ipcRenderer.invoke(DRIVE_CHANNEL.create, name, content),
    /** 新建文件夹（§157）。返回目录名或 null。 */
    mkdir: (name: string): Promise<string | null> => ipcRenderer.invoke(DRIVE_CHANNEL.mkdir, name),
    rename: (filePath: string, newName: string): Promise<string | null> =>
      ipcRenderer.invoke(DRIVE_CHANNEL.rename, filePath, newName),
    read: (filePath: string): Promise<string | null> => ipcRenderer.invoke(DRIVE_CHANNEL.read, filePath),
    download: (filePath: string, targetDir?: string) =>
      ipcRenderer.invoke(DRIVE_CHANNEL.download, filePath, targetDir),
  },
  /*
   * 会话日志（C2/F3）。
   *
   * ⚠️ 放**顶层**而不是塞进 workbench/ai：它是记录层 ——
   * 聊天与工作台写同一个目录，靠 `sessionId` 前缀（chat- / task-）区分。
   * 放在某一侧下会让另一侧"看起来没有这个能力"。
   */
  session: {
    /**
     * 列会话。不给参数 = 只列聊天（渲染层要的）。
     * `"all"` 给验收脚本用（它要看得到 `task-` 的工作台日志）。
     */
    list: (kind?: "chat" | "task" | "cli" | "all"): Promise<SessionSummary[]> =>
      ipcRenderer.invoke(SESSION_CHANNEL.list, kind),
    /** 读回一整段会话的记录（投影在渲染层做，主进程不重复算一遍）。 */
    load: (sessionId: string): Promise<{ records: unknown[]; skipped: number }> =>
      ipcRenderer.invoke(SESSION_CHANNEL.load, sessionId),
  },
  workbench: {
    /** 保存一个对话产物到磁盘，返回落盘路径与字节数。 */
    saveArtifact: (name: string, data: Uint8Array | string) =>
      ipcRenderer.invoke(ARTIFACT_CHANNEL.save, name, data),
    /** 用系统默认程序打开产物。返回空串表示成功。 */
    openArtifact: (filePath: string): Promise<string> =>
      ipcRenderer.invoke(ARTIFACT_CHANNEL.open, filePath),
    /** 在文件管理器里定位产物。 */
    revealArtifact: (filePath: string): Promise<boolean> =>
      ipcRenderer.invoke(ARTIFACT_CHANNEL.reveal, filePath),
    /** 列出产物目录里的所有文件。 */
    listArtifacts: () => ipcRenderer.invoke(ARTIFACT_CHANNEL.list),
  },
/*
 * ⚠️ **`satisfies ShellBridge`（C4）**：这一句就是"契约只有一份"的落点。
 *
 * 在这之前，`shared/ipc.ts` 的 `ShellBridge` 与这里的 `api` 是**两份手写形状**，
 * 已经漂移过：`ShellBridge` 缺 `memory` / `setTitlebar`，
 * `src/workbench/memoryStore.ts` 只好自己打补丁扩展类型（`MemoryBridge`）。
 * 漂移**不会报任何错** —— 只会表现为"类型说有、实际没有"（或反过来）。
 *
 * 加上 `satisfies` 之后：这里**少一个字段、多一个字段、签名差一点，`tsc` 立刻报错**。
 * 契约的唯一事实来源是 `ShellBridge`。
 *
 * 用法说明：`satisfies`（而不是 `: ShellBridge`）是刻意的 —— 它既做检查，
 * 又保留下面这份字面量的精确类型（`ShellApi = typeof api` 还要用它）。
 */
} satisfies ShellBridge;

contextBridge.exposeInMainWorld("shell", api);

export type ShellApi = typeof api;
