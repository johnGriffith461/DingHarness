/**
 * 主进程 ↔ 渲染进程的共享类型（AI 通道）。
 *
 * 放在 `shared/` 是因为两侧都要引；主进程的实现在 `electron/ipc/ai.ts`，
 * 渲染进程的封装在 `src/ai/aiClient.ts`。改这里就要两边一起改。
 */

import type {
  CanvasDocument,
  CanvasLoadResult,
  CanvasSaveResult,
  CanvasSnapshotFile,
} from "./canvas";

export type { CanvasDocument, CanvasLoadResult, CanvasSaveResult, CanvasSnapshotFile };

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = { role: ChatRole; content: string };

/** 脱敏后的 provider 信息。 */
export type ProviderInfo = {
  id: string;
  label: string;
  models: string[];
  note: string;
  /** 是否检测到可用密钥。**这不等于真的能调用**。 */
  available: boolean;
  /**
   * 本会话（或最近一次探测）里是否**真的成功调用过**。
   * `available: true, verified: false` = 有密钥但还没验证过 ——
   * 界面必须把这两级分开显示，否则用户点下去才发现用不了（本机实测确实有三个是这样）。
   */
  verified?: boolean;
};

export type ChatRequest = {
  provider: string;
  model?: string;
  messages: ChatMessage[];
  /**
   * 系统提示词。
   * **必须走这个字段**：AI SDK 默认拒绝 `messages` 里的 system 角色
   * （防提示注入），塞在消息数组里会让请求直接返回空。
   */
  system?: string;
  temperature?: number;
  /**
   * 审批档位（§143）。
   *
   * 为什么**必须随请求传**：模式选择在渲染进程（那个 chip），而工具执行在主进程 ——
   * 判定所需的信息得跨过这条边界。省略按「全部允许」（= 改造前的行为，向后兼容）。
   */
  toolPolicy?: ConfirmMode;
  /**
   * 是否把工具交给模型（**显式 opt-in，默认不带**）。
   *
   * ⚠️ 为什么默认不带（§143 撞到的一个真 bug）：
   * 起标题那次请求（`refineTitle`）与回答是**并行**发的。它原来也拿到了整个工具集，
   * 而它不带 `toolPolicy` → 主进程按默认「全部允许」处理 → **它也在执行工具**：
   * 一次发送造成了两次写记忆（一条来自回答、一条来自起标题）。
   *
   * 所以"带不带工具"必须由**发起方明确说**。起标题、翻译这类附带请求
   * 压根不该有动作能力 —— 它们不是 agent 回合。
   */
  useTools?: boolean;
  /**
   * 会话 id（C2）：主进程据此把这一轮写进**会话事件日志**（`userData/sessions/<id>.jsonl`）。
   *
   * 为什么要由发起方给：只有它知道"这一轮属于哪段对话/哪个任务"。
   * 工作台给**任务 id**、聊天给**对话 id**；起标题这类附带请求**不给**
   * （它们不是 agent 回合，记进去只会让日志里多出一堆无主的请求）。
   *
   * ⚠️ 它是**渲染进程给的**，主进程会先收窄成 `[A-Za-z0-9._-]` 才当文件名用
   * （见 `electron/ipc/sessionStore.ts` 的 `safeSessionId`）；不合法就当没给。
   */
  sessionId?: string;
};

/**
 * 输入区那个 chip 的三个档位（**词表属于契约，判定属于内核**）。
 *
 * 定义放在契约里而不是 `engine/core/policy.ts`：它出现在 `ChatRequest.toolPolicy`
 * 这类跨进程字段上，而"有哪些档位"是界面与内核都要认的**同一个词表** ——
 * 让契约去引内核会把依赖方向倒过来（shared ← engine ← hosts/src）。
 * 至于"这个档位下某个工具该 run / ask / hide"，那是策略，在 `engine/core/policy.ts`。
 */
export const CONFIRM_MODES = ["全部允许", "按需确认", "每步确认"] as const;
export type ConfirmMode = (typeof CONFIRM_MODES)[number];

/** 档位是否合法（从磁盘/本地存储读回来的东西一律不可信）。 */
export function normalizeConfirmMode(raw: unknown): ConfirmMode {
  /*
   * ⚠️ 默认档在 Phase 11.5 改成「按需确认」了（原来是「全部允许」）。
   *
   * 方案 11.5 的验收是"**默认档让陌生人敢用**" —— 而"什么都不配 = 写文件与跑命令
   * 都不问"对一个刚装好的人是不合适的：他不知道这东西会动他的文件。
   * 现在默认"读操作直接放行 / 写与执行需确认"，与他第一次上手时的心理预期一致；
   * 想全放开的人随时可以 `ding config set mode 全部允许`。
   *
   * ⚠️ 这一条**也影响老用户**（没显式设过档位的人）。这是有意的：`config.json` 里
   * 显式写过档位的人不受影响，没写过的按"没表达过偏好"处理 —— 而安全的那一侧是默认。
   */
  return CONFIRM_MODES.includes(raw as ConfirmMode) ? (raw as ConfirmMode) : "按需确认";
}

/**
 * 会话日志的两条读接口（F3）。
 *
 * ⚠️ 回的是**记录**不是"投影好的消息"：投影是纯函数（`engine/core/events.ts`），
 * 渲染层自己算 —— 主进程再算一遍就等于两份实现（C2 刚把它们并成一份）。
 */
export type SessionSummary = {
  /** 日志 id（`chat-<对话 id>`）。 */
  sessionId: string;
  /** 对话 id（界面用的那个）。 */
  conversationId: string;
  /** 标题（取这一会话第一条用户消息的第一行）。 */
  title: string;
  /** 最后写入时间（epoch ms）。 */
  updatedAt: number;
  bytes: number;
};

export type ChatStartResult = {
  requestId: string;
  ok: boolean;
  provider?: string;
  model?: string;
  error?: string;
};

export type AiStreamEvent =
  | { requestId: string; type: "text"; text: string }
  /*
   * 工具调用（§141）。**这两条是"工具协议"的事实来源** ——
   * 渲染进程据此把"模型调了什么、结果如何"记进这一步（step 事件化），
   * 而不是靠解析模型的自由文本去猜。
   *
   * 与 AI SDK 的语义对齐：一条 tool-call 必然配一条 tool-result（成功或失败都算），
   * 因为 tool_call_id 要配对（这也是上下文压缩时"切割点不许落在 tool result 上"的原因）。
   */
  | { requestId: string; type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { requestId: string; type: "tool-result"; toolCallId: string; toolName: string; output?: unknown; error?: string }
  | { requestId: string; type: "done"; usage?: { inputTokens?: number; outputTokens?: number } }
  | { requestId: string; type: "error"; message: string }
  /*
   * ── 一次委派的进度（Phase 7.3）───────────────────────────────
   *
   * ⚠️ 它是**流里的一等事件**，不是"塞在某个工具结果里的字段"。
   * 理由是可观测性有**期间状态**：并行派三个专家时，"谁在跑、谁跑完了、谁失败了"
   * 是过程中就该看得见的东西 —— 只体现在最后那份报告里的话，
   * 中途被停/被拦下的那些就永远查不到（重启后更是一片空白）。
   *
   * `started` 与 `finished` 用 `delegationId` 配对（投影按它就地更新，不追加两条）。
   */
  | {
      requestId: string;
      type: "delegation";
      delegationId: string;
      agent: string;
      task: string;
      status: "started" | "finished";
      /** 只在 `finished` 时有。 */
      ok?: boolean;
      summary?: string;
      steps?: number;
      error?: string;
    };

/** 用户放行一次工具调用时的请求（§144）。 */
export type ToolRunRequest = {
  name: string;
  /** 模型当时给的那份参数 —— 原样执行，不给前端改的机会。 */
  input: unknown;
  /**
   * 当前审批档位（§150）。
   *
   * 为什么放行时还要带上它：`spawn_agent` 会**按这个档位给子智能体建工具集** ——
   * 子智能体里的动作必须过同一道闸（审批穿透）。不带的话，子智能体就会在一次
   * "用户已放行"的名义下拿到全部放行权。
   */
  toolPolicy?: ConfirmMode;
  /**
   * 这是**拒绝**（C2/INV-3）：不执行，只把决定记进日志。
   *
   * 为什么让拒绝也走这条通道：拒绝原来是**纯渲染层**的动作（连 IPC 都不发），
   * 于是重启后那条留痕又变回「等你确认」、而"谁拒的"无从查证。
   * 与批准走同一条路之后，两种决定在日志里形状一致（`approved: true/false`）。
   */
  reject?: boolean;
  /**
   * 这是哪一次调用（与流事件里那个 `toolCallId` 同一个）。
   *
   * 决策记录靠它认人：一条被拦下的调用在日志里是
   * "拦下 → **谁批的** → 结果"三段，缺了它就只能按工具名猜（一次回复里可能有多次调用）。
   */
  toolCallId?: string;
  /** 属于哪段会话（与 `ChatRequest.sessionId` 同一个）。缺了就不记日志。 */
  sessionId?: string;
};

/** 放行执行的结果。`line` 是界面要显示的那一行（由主进程生成，前端不重算）。 */
export type ToolRunResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
  /** 界面行，例如 `⚙ 记忆：已保存，当前 3 条`。 */
  line: string;
};

/** 主进程发给渲染进程的画布命令（§146）。 */
export type CanvasCommand = {
  id: string;
  /** 要加哪种节点（v1 只支持字段名已核实的两种）。 */
  kind: "markdown" | "code";
  /** 节点内容。 */
  text: string;
  /** kind=code 时的语言。 */
  lang?: string;
};

/** 渲染进程执行完之后的回执。 */
export type CanvasCommandResult = {
  id: string;
  ok: boolean;
  nodeId?: string;
  /** 这次操作顺带把画布打开了（界面上要能说清"为什么画布突然开了"）。 */
  opened?: boolean;
  error?: string;
};

/** preload 暴露的 `window.shell`。 */
export type ShellBridge = {
  ping: () => Promise<{
    ok: boolean;
    platform: string;
    versions: { electron: string; node: string; chrome: string };
  }>;
  userDataDir: () => Promise<string>;
  /**
   * 「记忆」库的读写（§185 起聊天侧也会用）。
   *
   * ⚠️ 它原来**只存在于 preload**，契约里没有 —— 手册点名的两处漂移之一，
   * 后果是 `src/workbench/memoryStore.ts` 只好自己写一个 `MemoryBridge = ShellBridge & {…}`
   * 来"打补丁扩展类型"。C4 让 preload `satisfies ShellBridge` 之后，这条立刻被顶出来。
   *
   * 三个方法回的都是 `unknown`：**收窄在渲染层做**（记忆库的形状由 `shared/memory.ts` 定义，
   * 主进程只负责存取与归一化）。
   */
  memory: {
    read: () => Promise<unknown>;
    write: (lib: unknown) => Promise<unknown>;
    clear: () => Promise<unknown>;
  };
  /**
   * 窗口控制（自绘标题栏的三个按钮）。
   *
   * ⚠️ 这里**没有** `setTitlebar` 了（2026-10-15 删，M0 工单 1）：它服务的是
   * `titleBarOverlay` —— Windows 在窗体顶部覆盖层里画的那套**原生** caption 按钮。
   * 那套按钮固定在右上角约 138×36，而「云盘 / 插件·技能·伙伴 / 定时任务」三个视图
   * 自己的操作按钮就在同一处（`wb-cloud-new` 等，x=1359..1426），被压住半个字 ——
   * 用户报的「右上角按钮重复显示」。覆盖层已删，按钮改由应用自绘、配色归 CSS，
   * 这条改配色的通路整条撤掉（删不干净就会留下一条"调了没反应"的死通路）。
   *
   * 契约里**必须**留着这一组：删掉覆盖层之后，右上角就只剩这几个按钮了。
   */
  win: {
    minimize: () => Promise<void>;
    /** 最大化 ⇄ 还原；返回**操作后**的真实状态（不要回意图，图标会撒谎）。 */
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    /** 订阅最大化状态变化（双击标题栏 / Win+↑ / Snap 都会触发）。 */
    onMaximizedChange: (listener: (maximized: boolean) => void) => () => void;
  };
  ai: {
    listProviders: () => Promise<ProviderInfo[]>;
    /** 主动探测真实连通性（较慢，只在用户触发时跑）。 */
    probe: () => Promise<Array<{ id: string; ok: boolean; ms: number; error?: string }>>;
    chat: (request: ChatRequest) => Promise<ChatStartResult>;
    abort: (requestId: string) => Promise<{ ok: boolean }>;
    onStream: (listener: (event: AiStreamEvent) => void) => () => void;
    /**
     * 用户点了「允许」之后，**执行那一次被拦下的工具调用**（§144）。
     *
     * ⚠️ 安全口径：这是**产品闸**（别让模型擅自做事），**不是安全边界** ——
     * 渲染进程本来就能直接调各 store 的 IPC。别把它当授权机制依赖。
     */
    runTool: (request: ToolRunRequest) => Promise<ToolRunResult>;
  };
  canvas: {
    load: () => Promise<CanvasLoadResult>;
    save: (doc: CanvasDocument) => Promise<CanvasSaveResult>;
    ack: (revision: number) => Promise<{ ok: boolean }>;
    status: () => Promise<CanvasSnapshotFile>;
    revisions: () => Promise<Array<{ revision: number; updatedAt: string }>>;
    readRevision: (revision: number) => Promise<CanvasDocument | null>;
    restore: (
      revision: number,
    ) => Promise<{ ok: true; doc: CanvasDocument } | { ok: false; error: string }>;
    /** 导出 PNG（截取画布上的一块区域，落盘后返回路径）。 */
    exportPng: (request: {
      rect: { x: number; y: number; width: number; height: number };
      name?: string;
    }) => Promise<{ ok: true; file: string; width: number; height: number } | { ok: false; error: string }>;
    /** 打开导出目录。 */
    revealExports: () => Promise<{ ok: boolean; dir?: string }>;
    /**
     * 订阅主进程发来的画布命令（§146）。
     *
     * 为什么要这条推送：画布文档由**渲染进程持有**（主进程只管落盘与版本），
     * 所以主进程**不能直接改文档** —— 会被渲染侧的自动保存覆盖掉。
     * 正确做法是"主进程说要加什么，渲染进程去加，然后回执"。
     */
    onCommand: (listener: (cmd: CanvasCommand) => void) => () => void;
    /** 执行完回执给主进程（工具那边在等这个）。 */
    commandResult: (result: CanvasCommandResult) => Promise<boolean>;
  };
  image: {
    /** 列出可用的图像模型（只列真的配了密钥的）。 */
    listModels: () => Promise<Array<{ id: string; label: string; models: string[]; note: string }>>;
    /** 生成一张图，落盘后返回文件名与可直链的 url。 */
    generate: (request: {
      prompt: string;
      model?: string;
      size?: string;
    }) => Promise<
      | { ok: true; name: string; url: string; bytes: number; ms: number; model: string; size?: string }
      | { ok: false; error: string }
    >;
    /** 以一张已有图为输入做编辑（图生图）。 */
    edit: (request: {
      source: string;
      prompt: string;
      model?: string;
      size?: string;
    }) => Promise<
      | {
          ok: true;
          name: string;
          url: string;
          bytes: number;
          ms: number;
          model: string;
          size: string;
          /** 输入图被规整过时的说明（界面可以显示出来）。 */
          inputNote?: string;
        }
      | { ok: false; error: string }
    >;
  };
  /** 对话产物（阶段 11.1）：任务产出的文件落盘、打开、定位。 */
  workbench: {
    /** 保存一个产物到磁盘；`name` 由渲染进程给（主进程会再校验一遍）。 */
    saveArtifact: (
      name: string,
      data: Uint8Array | string,
    ) => Promise<{ filePath: string; name: string; bytes: number }>;
    /** 用系统默认程序打开。返回空串表示成功，否则是错误说明。 */
    openArtifact: (filePath: string) => Promise<string>;
    /** 在文件管理器里定位。 */
    revealArtifact: (filePath: string) => Promise<boolean>;
    /** 列出产物目录里的所有文件（重启后恢复列表用）。 */
    listArtifacts: () => Promise<Array<{ filePath: string; name: string; bytes: number }>>;
  };
  /**
   * 本机版应用设置（§183）。
   *
   * 走主进程的原子写（不走 localStorage —— §156 的教训：硬杀进程就没了）。
   */
  appSettings: {
    read: () => Promise<{ pinnedModel: string }>;
    write: (next: { pinnedModel: string }) => Promise<{ pinnedModel: string }>;
  };
  /** 创作广场的「喜欢」（§180）：只存名字，不编点赞数。 */
  coding: {
    loadLiked: () => Promise<string[]>;
    saveLiked: (liked: string[]) => Promise<boolean>;
  };
  /**
   * 剪贴板（§173）：走主进程。
   *
   * 渲染进程的 `navigator.clipboard` 在本机页面（非安全上下文）不让用，
   * 而且要弹权限框 —— "点一下粘贴"不该那么重。
   */
  clipboard: {
    read: () => Promise<string>;
    write: (text: string) => Promise<boolean>;
  };
  /** 云盘（阶段 11.5）：真实目录里的文件列表、导入、删除、打开。 */
  drive: {
    list: () => Promise<
      Array<{
        name: string;
        path: string;
        bytes: number;
        createdAt: number;
        modifiedAt: number;
        kind: string;
        origin: "artifact" | "export" | "drive";
      }>
    >;
    /**
     * 弹系统文件选择框导入到云盘；返回**按文件**的结果（§170）。
     */
    importFiles: () => Promise<{
      imported: number;
      dir: string;
      items: Array<{ name: string; ok: boolean; reason?: string; savedAs?: string }>;
    }>;
    /**
     * 按**内容**导入（§171，拖拽走这条 —— 拖进来的东西不一定有磁盘路径）。
     */
    importData: (items: Array<{ name: string; data: Uint8Array }>) => Promise<{
      imported: number;
      dir: string;
      items: Array<{ name: string; ok: boolean; reason?: string; savedAs?: string }>;
    }>;
    /**
     * 从一批路径导入（拖拽 / 批量 / 验收走这条，与对话框入口**共用同一段实现**）。
     */
    importPaths: (paths: string[]) => Promise<{
      imported: number;
      dir: string;
      items: Array<{ name: string; ok: boolean; reason?: string; savedAs?: string }>;
    }>;
    remove: (filePath: string) => Promise<boolean>;
    reveal: (filePath: string) => Promise<boolean>;
    /** 用系统默认程序打开。返回空串表示成功。 */
    open: (filePath: string) => Promise<string>;
    /** 创建副本（同目录、名字加「-副本」）。返回新文件名或 null。 */
    duplicate: (filePath: string) => Promise<string | null>;
    /** 新建一个文本文件（对标云盘「＋新建」）。返回新文件名或 null。 */
    create: (name: string, content?: string) => Promise<string | null>;
    /** 新建文件夹（§157）。返回目录名或 null。 */
    mkdir: (name: string) => Promise<string | null>;
    /** 重命名（§158）。返回新名字或 null（重名/非法名的时候）。 */
    rename: (filePath: string, newName: string) => Promise<string | null>;
    /**
     * 下载 / 另存为（§169）。
     *
     * @param targetDir 给了就静默复制到这个目录；不给就弹系统"另存为"框
     */
    download: (
      filePath: string,
      targetDir?: string,
    ) => Promise<{ ok: boolean; savedTo?: string; canceled?: boolean }>;
    /** 读成文本（§158，「AI 阅读」用）。读不了或太大返回 null。 */
    read: (filePath: string) => Promise<string | null>;
  };
  /** 定时任务（阶段 11.6）：读 / 写（原子写） */
  schedules: {
    load: () => Promise<unknown[]>;
    save: (jobs: unknown) => Promise<boolean>;
    /**
     * 主进程改了定时任务时通知渲染进程（§145）。
     *
     * 工具的 `schedule_create` 在主进程写盘，而渲染侧的调度器用的是它内存里那份列表 ——
     * 不通知的话，工具刚建的任务当次会话不会被跑（"看着建好了、其实没用"）。
     */
    onChanged: (listener: () => void) => () => void;
  };
  /** 本机库（阶段 11.7 / 11.8）：装过的插件、项目、置顶、收藏。 */
  library: {
    load: () => Promise<unknown>;
    save: (value: unknown) => Promise<boolean>;
  };
  /** 搜索历史（§162）—— 两处搜索各一份。 */
  searchHistory: {
    load: () => Promise<unknown>;
    save: (history: unknown) => Promise<unknown>;
  };
  /**
   * 工作区：**用户授权给 agent 的目录**（2026-10-14）。
   *
   * 这是「agent 能真干活」的前提：在那之前它能碰的只有应用自己那几个目录。
   * ⚠️ `add` **不接受路径参数** —— 它只弹系统目录选择器，选中的才算授权
   * （渲染层能传路径的话，"用户授权"就是假的）。
   */
  /**
   * 连接器（MCP server，2026-10-14）。
   *
   * 与 goose 的 extensions / opencode 的 mcp 段同一件事：把外部工具接进来。
   * 配置在 `mcp.json`（界面只做"看状态 + 打开配置文件 + 重连"）。
   */
  mcp: {
    list: () => Promise<{
      file: string;
      empty: string;
      servers: Array<{
        name: string;
        command: string;
        args: string[];
        enabled: boolean;
        status: "starting" | "on" | "error" | "off";
        line: string;
        error: string;
        tools: Array<{ localName: string; name: string; description: string }>;
      }>;
    }>;
    reload: () => Promise<unknown>;
    openConfig: () => Promise<{ ok: boolean; error: string }>;
  };
  workspace: {
    list: () => Promise<{ dirs: string[] }>;
    /** 弹目录选择器；用户取消时 `dir` 为 null（列表原样返回）。 */
    add: () => Promise<{ dir: string | null; list: { dirs: string[] } }>;
    remove: (dir: string) => Promise<{ dirs: string[] }>;
  };
  /** 本机 AI 智能体（§156）。 */
  agents: {
    load: () => Promise<unknown[]>;
    save: (agents: unknown) => Promise<unknown[]>;
  };
  /** AI 阅读的「最近阅读」（§155）。 */
  readings: {
    load: () => Promise<unknown[]>;
    save: (readings: unknown) => Promise<unknown[]>;
  };
  /** AI 文档（§153）：一次读写整库。 */
  docs: {
    load: () => Promise<unknown[]>;
    save: (docs: unknown) => Promise<unknown[]>;
  };
  /** 工作台任务（阶段 11.9）：读 / 写（原子写）。 */
  tasks: {
    load: () => Promise<unknown[]>;
    save: (tasks: unknown) => Promise<boolean>;
  };
  /** 远端控制的本机侧状态（阶段 11.26）。 */
  /**
   * 会话日志（C2/F3）。
   *
   * ⚠️ 它**不在** `shell.workbench` / `shell.ai` 里，因为它是**记录层**：
   * 谁写的（聊天/工作台）都由 `sessionId` 前缀区分。
   */
  session: {
    /**
     * 列会话。
     *
     * ⚠️ 不给参数 = **只列聊天**（渲染层要的就是这个，行为与以前一致）。
     * `"all"` 是给验收脚本用的：它要看到工作台任务的日志（`task-` 前缀），
     * 而那些**从来不在聊天列表里** —— 以前脚本靠"直接读 sessions/ 目录"绕过去，
     * 存储换成 SQLite 之后那条路没了（Phase 4.3），所以这里补上口子。
     */
    list: (kind?: "chat" | "task" | "cli" | "all") => Promise<SessionSummary[]>;
    load: (sessionId: string) => Promise<{ records: unknown[]; skipped: number }>;
  };
  /**
   * 插件（Phase 8.4）。
   *
   * ⚠️ `install` **不接受渲染进程给的路径**：目录由系统对话框选
   * （与"工作区授权"同一条理由 —— 否则"安装"等于"让主进程执行任意目录里的代码"）。
   */
  plugins: {
    /** 列已装插件（含"申请了但没批"与装载时发现的问题）。 */
    list: () => Promise<
      {
        name: string;
        version: string;
        description: string;
        enabled: boolean;
        granted: readonly string[];
        requested: readonly string[];
        withheld: readonly string[];
        declaredOnly: readonly string[];
        problems: string[];
        toolCount: number;
      }[]
    >;
    /**
     * 安装。
     *
     * - 不给参数：弹系统目录对话框装本地目录（**目录由对话框给**，不收渲染进程的路径）；
     * - 给 `npm:<包名>`：从 npm 装（包名会被主进程**严格校验** —— 包名不是路径）。
     */
    install: (spec?: string) => Promise<{ ok: boolean; canceled?: boolean; plugin?: string; errors?: string[]; list?: unknown }>;
    /** 开/关（关 = 不装载它的工具与钩子，台账留着）。 */
    setEnabled: (name: string, enabled: boolean) => Promise<{ ok: boolean; errors?: string[]; list?: unknown }>;
    /** 卸载（台账与它拷贝进来的内容一起清；不碰用户给的源目录）。 */
    uninstall: (name: string) => Promise<{ ok: boolean; errors?: string[]; list?: unknown }>;
    /** 体检：目录不在的、被扣下能力的。 */
    doctor: () => Promise<{ missing: string[]; withheld: { plugin: string; permissions: readonly string[] }[] }>;
  };
  remote: {
    status: () => Promise<{ allowConnect: boolean; keepAwake: boolean }>;
    setKeepAwake: (on: boolean) => Promise<boolean>;
    setAllowConnect: (on: boolean) => Promise<boolean>;
  };
  /** 视频生成（阶段 11.12）：模型清单 + 提交生成。 */
  video: {
    listModels: () => Promise<string[]>;
    generate: (
      prompt: string,
      model?: string,
    ) => Promise<
      | { ok: true; name: string; url: string; bytes: number; ms: number; model: string }
      | { ok: false; error: string }
    >;
  };
};
