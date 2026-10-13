import { create } from "zustand";
import type { AiStreamEvent, ChatMessage, ProviderInfo } from "@shared/ipc";
import { mergeToolTraces, rejectedLine, type ToolTrace } from "@shared/agentTools";
import { applyEvent, emptyTurn, finishTurn } from "@shared/sessionLog";
import { artifactFileName, extractArtifacts, type Artifact } from "@/workbench/artifact";
import { enabledPromptBlock } from "@shared/library";
import type { ShellBridge } from "@shared/ipc";
import { runToolOnce } from "./aiClient";
import { readConfirmMode } from "@/workbench/confirmMode";
import { abortStream, listProviders, probeProviders, streamChat } from "./aiClient";

/**
 * 侧栏对话状态（PLAN 3.1）。
 *
 * 一次会话 = 一串消息 + 当前选用哪个 provider / 模型。
 * 流式片段按 ~80ms 节流写进 store：逐字 setState 会让整个侧栏每帧重渲染。
 *
 * provider 选择持久化在 localStorage —— 它是用户偏好，不是画布内容，
 * 不该混进阶段 4 的画布快照里。
 */

export type ChatMessageStatus = "streaming" | "done" | "error";

export type ChatMessageRecord = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: ChatMessageStatus;
  error?: string;
  createdAt: number;
  /** 这条回答用哪个模型产出的（便于对照效果）。 */
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /**
   * 这条回复里**被闸门拦下**的工具调用（§185）。
   *
   * ⚠️ 只放 `pending` 的那些：它们是"**在等人**"的，必须给出路（允许/拒绝）。
   * 已经执行完的仍然只进正文那一行（原有口径不变）。
   */
  tools?: ToolTrace[];
  /**
   * 这条回复产出的文件（§186）。
   *
   * 与工作台**同一套**：模型在正文里写 `<artifact type=… title=…>…</artifact>`，
   * 这里把它提成卡片、正文只留干净文本。
   *
   * ⚠️ 不做的话：模型在聊天里写了产物标签，用户看到的是**一串标签原文**，
   * 而且文件在磁盘上、界面上看不见 —— 正是 §141 打的"暗箱"。
   */
  artifacts?: Artifact[];
};

export type ChatConversation = {
  id: string;
  title: string;
  createdAt: number;
};

type ProviderSettings = { provider: string; model: string };

/**
 * 系统提示词里的能力说明（§185）。
 *
 * 与工作台**同一来源**：用户在插件·技能·伙伴里开了什么，聊天里就有什么。
 * 动态导入 `libraryStore`（避免顶层循环依赖，与工作台那处一致）。
 *
 * @returns 能力说明；拿不到就返回空串
 */
/**
 * 把聊天里提取出来的产物落盘，并把 `filePath` / 字节数写回那条消息（§186）。
 *
 * 与工作台 `persistArtifacts` 同一套做法：**先落盘再显示路径** ——
 * 卡片上写着文件名却没有文件，比没有卡片更糟。
 *
 * ⚠️ 产物**挂在消息上**（不是任务上）：聊天没有任务这个概念。
 *
 * @param conversationId 哪段对话
 * @param messageId 哪条回复
 * @param artifacts 刚提取出来的产物
 */
async function persistChatArtifacts(
  conversationId: string,
  messageId: string,
  artifacts: Artifact[],
): Promise<void> {
  /* 先把卡片显示出来（状态 generating），落盘之后补路径 */
  const patch = (next: (arts: Artifact[]) => Artifact[]) =>
    useChatStore.setState((prev) => ({
      messages: {
        ...prev.messages,
        [conversationId]: (prev.messages[conversationId] ?? []).map((m) =>
          m.id === messageId ? { ...m, artifacts: next(m.artifacts ?? []) } : m,
        ),
      },
    }));

  patch(() => artifacts);

  const bridge = (globalThis as unknown as { shell?: ShellBridge }).shell;
  if (!bridge?.workbench) return;

  for (const artifact of artifacts) {
    try {
      const saved = await bridge.workbench.saveArtifact(artifactFileName(artifact), artifact.content ?? "");
      patch((arts) =>
        arts.map((a) =>
          a.id === artifact.id ? { ...a, status: "generated" as const, filePath: saved.filePath, bytes: saved.bytes } : a,
        ),
      );
    } catch {
      patch((arts) => arts.map((a) => (a.id === artifact.id ? { ...a, status: "failed" as const } : a)));
    }
  }
}

async function abilityBlock(): Promise<string> {
  try {
    const { useLibraryStore, findItemIn } = await import("@/workbench/libraryStore");
    const lib = useLibraryStore.getState().lib;
    return enabledPromptBlock(lib, (id: string) => findItemIn(lib, id));
  } catch {
    return "";
  }
}

const SETTINGS_KEY = "dsh-canvas.chat-settings";

function loadSettings(): ProviderSettings | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProviderSettings;
    if (typeof parsed.provider === "string" && typeof parsed.model === "string") return parsed;
  } catch {
    /* 坏数据就当没有 */
  }
  return null;
}

function saveSettings(settings: ProviderSettings): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${(seq += 1)}`;

/** 供画布侧（生成编排）在非组件环境里读设置。 */
export function currentChatSettings(): ProviderSettings {
  const state = useChatStore.getState();
  return { provider: state.provider, model: state.model };
}

export type ChatState = {
  conversations: ChatConversation[];
  activeId: string;
  messages: Record<string, ChatMessageRecord[]>;
  providers: ProviderInfo[];
  provider: string;
  model: string;
  /** 正在流式输出的请求 id（空串表示空闲）。 */
  streamingId: string;
  /** 正在流式输出的消息 id（用于把增量写回正确的消息）。 */
  streamingMessageId: string;
  error: string | null;
  /** 正在跑 provider 连通性探测（界面据此禁用按钮）。 */
  probing: boolean;

  loadProviders: () => Promise<void>;
  /** 主动探测各 provider 真实连通性（会把结果刷进列表）。 */
  probeProviders: () => Promise<void>;
  setModel: (provider: string, model: string) => void;
  newConversation: () => string;
  selectConversation: (id: string) => void;
  /**
   * 处置一条**被闸门拦下**的工具调用（§185）。
   *
   * @param conversationId 哪段对话
   * @param messageId 哪条回复
   * @param toolCallId 哪一条留痕
   * @param approve 「允许」原样执行 / 「拒绝」只留痕
   */
  resolveTool: (
    conversationId: string,
    messageId: string,
    toolCallId: string,
    approve: boolean,
  ) => Promise<void>;

  send: (text: string, contextBlock?: string) => Promise<void>;
  abort: () => void;
  clearError: () => void;
};

const initialConversation: ChatConversation = {
  id: "c1",
  title: "新对话",
  createdAt: Date.now(),
};

const stored = loadSettings();

export const useChatStore = create<ChatState>()((set, get) => ({
  conversations: [initialConversation],
  activeId: initialConversation.id,
  messages: { [initialConversation.id]: [] },
  providers: [],
  provider: stored?.provider ?? "",
  model: stored?.model ?? "",
  streamingId: "",
  streamingMessageId: "",
  error: null,
  probing: false,

  loadProviders: async () => {
    const providers = await listProviders();
    const usable = providers.filter((p) => p.available);
    const current = get();
    /**
     * 自动选谁：**优先已验证可用的**，其次只是有密钥的。
     *
     * 这个顺序很重要：本机实测有密钥 ≠ 真能用（apihub 域名不可达、通义千问 400、
     * 本地服务没起）。如果一上来就选"有密钥但根本不通"的那家，用户会以为整个 AI 坏了。
     */
    const verified = usable.filter((p) => p.verified);
    const preferred = verified[0] ?? usable[0];
    const stillValid = usable.some((p) => p.id === current.provider);
    const next = stillValid ? current.provider : (preferred?.id ?? providers[0]?.id ?? "");
    const models = providers.find((p) => p.id === next)?.models ?? [];
    const model = stillValid && models.includes(current.model) ? current.model : (models[0] ?? "");
    set({ providers, provider: next, model });
    if (next) saveSettings({ provider: next, model });
  },

  /** 主动探测真实连通性，并把结果刷新到列表上。 */
  probeProviders: async () => {
    set({ probing: true });
    try {
      await probeProviders();
      const providers = await listProviders();
      set({ providers });
    } finally {
      set({ probing: false });
    }
  },

  setModel: (provider, model) => {
    set({ provider, model });
    saveSettings({ provider, model });
  },

  newConversation: () => {
    const conversation: ChatConversation = {
      id: nextId("c"),
      title: "新对话",
      createdAt: Date.now(),
    };
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      activeId: conversation.id,
      messages: { ...state.messages, [conversation.id]: [] },
    }));
    return conversation.id;
  },

  selectConversation: (id) => {
    if (!get().messages[id]) set((state) => ({ messages: { ...state.messages, [id]: [] } }));
    set({ activeId: id });
  },

  clearError: () => set({ error: null }),

  abort: () => {
    const { streamingId, streamingMessageId, activeId } = get();
    if (!streamingId) return;
    void abortStream(streamingId);
    set((state) => ({
      streamingId: "",
      messages: {
        ...state.messages,
        [activeId]: (state.messages[activeId] ?? []).map((m) =>
          m.id === streamingMessageId
            ? { ...m, status: "done" as const, content: m.content || "（已中止）" }
            : m,
        ),
      },
    }));
  },

  resolveTool: async (conversationId, messageId, toolCallId, approve) => {
    /** 只改那一条 trace（按 toolCallId 定位，不能按工具名 —— 一条回复里可能有多条）。 */
    const patchTrace = (next: Partial<ToolTrace>) =>
      set((prev) => ({
        messages: {
          ...prev.messages,
          [conversationId]: (prev.messages[conversationId] ?? []).map((m) =>
            m.id !== messageId
              ? m
              : {
                  ...m,
                  tools: (m.tools ?? []).map((tt) =>
                    tt.toolCallId === toolCallId ? { ...tt, ...next } : tt,
                  ),
                },
          ),
        },
      }));

    const trace = get()
      .messages[conversationId]?.find((m) => m.id === messageId)
      ?.tools?.find((tt) => tt.toolCallId === toolCallId);
    if (!trace) return;

    if (!approve) {
      patchTrace({ pending: false, ok: true, line: rejectedLine(trace.name) });
      return;
    }

    /*
     * ⚠️ 必须带上当前档位（§150）：`spawn_agent` 会按它给**子智能体**建工具集。
     * 不带的话，子智能体就会在一次"用户已放行"的名义下拿到全部放行档 —— 
     * 那正是"审批穿透"要防的事。
     */
    const result = await runToolOnce({
      name: trace.name,
      input: trace.input,
      toolPolicy: readConfirmMode(),
    });
    patchTrace({
      pending: false,
      ok: result.ok,
      line: result.line,
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  },


  send: async (text, contextBlock) => {
    const state = get();
    const conversationId = state.activeId;
    const trimmed = text.trim();
    if (!trimmed || state.streamingId) return;

    const userMessage: ChatMessageRecord = {
      id: nextId("m"),
      role: "user",
      content: trimmed,
      status: "done",
      createdAt: Date.now(),
    };
    const assistantMessage: ChatMessageRecord = {
      id: nextId("m"),
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: Date.now(),
      model: state.model,
    };

    const history = state.messages[conversationId] ?? [];
    const payload: ChatMessage[] = [
      ...history
        .filter((m) => m.status !== "error")
        .map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
      { role: "user", content: contextBlock ? `${contextBlock}\n\n${trimmed}` : trimmed },
    ];

    /**
     * 开发期观察点：把"这一轮真实发给模型的消息"挂到 window 上。
     * 验收引用芯片、素材上下文这类"内容到底有没有进请求"的功能时，
     * 需要断言的是最终请求体，而不是界面上的中间状态（见 HANDOFF §16 的同类做法）。
     */
    if (import.meta.env.DEV && typeof window !== "undefined") {
      (window as unknown as { __lastChatPayload?: unknown }).__lastChatPayload = payload;
    }

    set((prev) => ({
      messages: {
        ...prev.messages,
        [conversationId]: [...(prev.messages[conversationId] ?? []), userMessage, assistantMessage],
      },
      error: null,
      // 会话标题取第一句话，便于在列表里认
      conversations: prev.conversations.map((c) =>
        c.id === conversationId && c.title === "新对话"
          ? { ...c, title: trimmed.slice(0, 24) }
          : c,
      ),
    }));

    // 增量节流写回
    let pending = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    /*
     * ── 这一轮的**投影**（C2）──────────────────────────────────────
     *
     * 原来这段是个手写状态机：`acc` 攒正文、`pendingInputs` 这个 Map 自己配对参数、
     * 每个分支自己判 `pending`。同样的状态机在**工作台**里还有一份（`store.ts`），
     * 于是两边慢慢答得不一样（实测：工作台不接 `usage`、聊天不展开子智能体上交的调用）。
     *
     * 现在只有一份：`applyEvent`（`shared/sessionLog.ts`）。它同时是
     * "流式增量"与"日志投影"—— 日志落盘走的是同一个函数，所以
     * **界面看到的与日志记下的不可能不一致**。
     *
     * ⚠️ 正文不再单独攒一份（原来那个 `acc`）：`state.text` 就是它，
     * 而且它同时能作为日志投影用 —— 两份的根本风险是它们会不一样。
     */
    let turn = emptyTurn();
    /**
     * 聊天侧**不展开**子智能体上交的调用（`expandBlocked` 默认关）—— 那是现状。
     * 统一它会让聊天多出可放行的按钮（行为变更），单独决定（见 C2 方案的差异清单）。
     */
    const project = () => finishTurn(turn);

    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pending) return;
      const chunk = pending;
      pending = "";
      set((prev) => ({
        messages: {
          ...prev.messages,
          [conversationId]: (prev.messages[conversationId] ?? []).map((m) =>
            m.id === assistantMessage.id ? { ...m, content: m.content + chunk } : m,
          ),
        },
      }));
    };

    const started = await streamChat(
      {
        provider: state.provider,
        model: state.model,
        messages: payload,
        /*
         * ⚠️ 这两项原来**没有**（§185）。
         *
         * 工作台那条路传了 `useTools: true`，聊天这条路没传 —— 于是聊天
         * **根本拿不到工具**：下面那几个 `tool-call` / `tool-result` 分支
         * 在此之前**永远不会被触发**（注释里写着"必须显式写出来"，
         * 但真正决定有没有工具的那个开关在**请求**上）。
         *
         * 补上之后：聊天里"被闸门拦下 → 就地允许/拒绝"才是一条活路。
         */
        useTools: true,
        // 审批档位随请求过界（§143）：模式选择在这边，工具执行在那边
        toolPolicy: readConfirmMode(),
        // 会话日志（C2）：主进程把这一轮完整记下来（请求体 / 事件 / 用量）
        sessionId: conversationId,
        /*
         * 能力说明（§185）。
         *
         * ⚠️ 聊天原来**连系统提示词都没有**。既然现在给了工具，
         * 就得告诉模型"你能用哪些" —— 光给 schema 不给说明，
         * 模型会用得很糟（该用工具的时候在那儿解释半天）。
         *
         * 这一段与工作台**同一来源**（`enabledPromptBlock`）：用户
         * 在插件·技能·伙伴里开了什么，聊天里就有什么 —— 两处口径一致。
         */
        system: await abilityBlock(),
      },
      (event: AiStreamEvent) => {
        /*
         * ⭐ **先过投影，再管界面**（C2）。
         *
         * 顺序很重要：投影是"这一轮发生了什么"的事实，界面只是它的一种呈现。
         * 反过来的话（先写界面、再补一句"顺便记一下"），两边迟早会漂移。
         */
        turn = applyEvent(turn, event);

        if (event.type === "text") {
          pending += event.text;
          if (!flushTimer) flushTimer = setTimeout(flush, 80);
          return;
        }
        if (event.type === "done") {
          flush();
          /*
           * 产物提取（§186）：与工作台同一套 `extractArtifacts`。
           *
           * 只在 done 这一步做（不做在流式过程中）：标签是边流边出现的，
           * 半截标签被切掉反而更难看；收尾时一次性换成卡片。
           *
           * 正文取自**投影**（不再单独攒 `acc`）：两边正是"同一个东西的两份拷贝"，
           * 而它们一旦不一致，产物提取的结果就会跟日志对不上。
           */
          const extracted = extractArtifacts(
            project().text,
            `chat-${conversationId}`,
            Date.now(),
            (i) => `chat-${conversationId}-${assistantMessage.id}-a${i + 1}`,
          );
          /*
           * ⚠️ 正文要换成**提取之后**的版本（§186）：不换的话，
           * 用户看到的是 `<artifact …>` 那一串标签原文，
           * 而文件已经落盘了 —— 既难看又像坏了。
           */
          set((prev) => ({
            messages: {
              ...prev.messages,
              [conversationId]: (prev.messages[conversationId] ?? []).map((m) =>
                m.id === assistantMessage.id ? { ...m, content: extracted.text } : m,
              ),
            },
          }));
          if (extracted.artifacts.length) {
            void persistChatArtifacts(conversationId, assistantMessage.id, extracted.artifacts);
          }
          set((prev) => ({
            streamingId: "",
            streamingMessageId: "",
            messages: {
              ...prev.messages,
              [conversationId]: (prev.messages[conversationId] ?? []).map((m) =>
                m.id === assistantMessage.id
                  ? // 用量取自投影（主进程给多少就是多少，拿不到就是 undefined —— 不编）
                    { ...m, status: "done" as const, usage: project().usage }
                  : m,
              ),
            },
          }));
          return;
        }
        /*
         * 工具事件（§141）。
         *
         * ⚠️ 这两条分支**必须显式写出来**：原来的代码是"不是 text / done 就当 error"，
         * 加了工具事件之后，那条兜底会把"模型调了工具"记成**一次报错**。
         * （把重复的 `AiStreamEvent` 定义合并到 `shared/ipc.ts` 之后，
         *   类型检查立刻指出了这里 —— 拆两处定义时它只会静默不认。）
         *
         * tool-call 只表示"正在调"，不放内容；结果那条落成一行小字进正文，
         * 位置就是它真实发生的位置（模型先说了半句 → 工具 → 接着说完）。
         */
        if (event.type === "tool-call") {
          /*
           * 参数**不用在这里自己存**了（C2）：投影里已经按 `toolCallId` 配好对
           * （`shared/sessionLog.ts` 的 `waiting`）。原来这里有个 `pendingInputs` Map，
           * 工作台那份状态机里有**另一个一模一样的** Map —— 两个 Map 就是两份真相。
           */
          return;
        }
        if (event.type === "tool-result") {
          flush();
          /*
           * 那一行与那条留痕都**取自投影**：`line` 由 `describeToolResult` 在投影里生成，
           * `pending` 也是投影判的。界面不再自己算一遍 —— 算第二遍就是第二个答案。
           */
          const trace = project().traces.find((t) => t.toolCallId === event.toolCallId);
          const line = trace?.line ?? "";
          /*
           * 被拦下的那一条还要**挂成可处置的留痕**（§185）：
           * 只写「等你确认」而没有按钮，就是一条无法处置的通知
           * （§176 为子智能体修过同款问题）。
           *
           * 聊天侧只放 `pending` 的那些（已经执行完的仍只进正文那一行，§185 的口径）。
           */
          const pendingTraces = project().traces.filter((t) => t.pending);
          set((prev) => ({
            messages: {
              ...prev.messages,
              [conversationId]: (prev.messages[conversationId] ?? []).map((m) =>
                m.id === assistantMessage.id
                  ? {
                      ...m,
                      content: line ? (m.content ? `${m.content}\n\n${line}` : line) : m.content,
                      /*
                       * ⚠️ **合并、不是覆盖**（C2 期间逮到的一个真回归）：
                       * 投影每来一条 `tool-result` 就重算一次；若直接用它覆盖列表，
                       * 用户刚点过的「允许」会被抹回 `pending`（主进程并不知道谁批过），
                       * 于是按钮又冒出来、用户以为没生效。**界面已有的那条说了算。**
                       */
                      ...(pendingTraces.length
                        ? { tools: mergeToolTraces(m.tools ?? [], pendingTraces) }
                        : {}),
                    }
                  : m,
              ),
            },
          }));
          return;
        }
        // error
        flush();
        set((prev) => ({
          streamingId: "",
          streamingMessageId: "",
          error: event.message,
          messages: {
            ...prev.messages,
            [conversationId]: (prev.messages[conversationId] ?? []).map((m) =>
              m.id === assistantMessage.id
                ? {
                    ...m,
                    status: "error" as const,
                    error: event.message,
                    content: m.content || `（失败：${event.message}）`,
                  }
                : m,
            ),
          },
        }));
      },
    );

    set({ streamingId: started.requestId, streamingMessageId: assistantMessage.id });
  },
}));
