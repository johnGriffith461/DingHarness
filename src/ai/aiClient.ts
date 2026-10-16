import type {
  AiStreamEvent,
  ChatMessage,
  ChatRequest,
  ChatStartResult,
  ProviderInfo,
  ShellBridge,
  ToolRunRequest,
  ToolRunResult,
} from "@shared/ipc";

/**
 * AI 通道的渲染进程封装。
 *
 * 有两条使用路径：
 *   · 侧栏对话 —— 订阅增量、边到边渲染（`streamChat` 返回的 `abort` 用来中止）
 *   · 画布生成 —— 等整段内容拿全再落节点（`completeOnce` 等 `done`）
 *
 * 关键约定：`streamChat` 返回的 Promise **在流结束时才 resolve**，
 * 不是"请求已发出"就 resolve —— 否则 `await completeOnce(...)` 会立即返回空串。
 *
 * 为什么在浏览器里跑时要有 mock：Vite dev server 直接开在浏览器里能看到画布，
 * 但那时没有 preload、没有主进程，AI 调用必然失败。这里给一份明确的降级实现，
 * 让"能用画布但不显示 AI 结果"与"AI 真的失败了"这两件事在界面上分得清。
 */

const bridge = (): ShellBridge | undefined =>
  (globalThis as unknown as { shell?: ShellBridge }).shell;

/** 是否运行在 Electron 壳里（有 preload 桥）。 */
export function hasShellBridge(): boolean {
  return Boolean(bridge()?.ai);
}

/** 浏览器里跑时的占位 provider 列表。 */
const BROWSER_PROVIDERS: ProviderInfo[] = [
  {
    id: "unavailable",
    label: "不可用（未在 Electron 中运行）",
    models: [],
    note: "AI 通道需要主进程：请用 pnpm dev:app 从 Electron 启动",
    available: false,
    /*
     * ⚠️ `keyRef` 是 2026-10-16 起契约里的必填字段（设置里「填 key」要用它决定写到哪个名字下）。
     * 这条占位记录代表的就是"不在 Electron 里、没有 AI 通道"——**没有**密钥通道可言，
     * 所以如实给空串，而不是编一个名字出来（编译不过是另一会话改契约时漏了这个构造点）。
     */
    keyRef: "",
  },
];

export async function listProviders(): Promise<ProviderInfo[]> {
  const shell = bridge();
  if (!shell?.ai) return BROWSER_PROVIDERS;
  try {
    return await shell.ai.listProviders();
  } catch (error) {
    /*
     * ⚠️ 2026-10-16（审计 P238）：这里原来**把主进程抛错也当成「没在 Electron 里跑」**，
     * 于是界面告诉用户「请用 pnpm dev:app 从 Electron 启动」—— 指错方向：
     * 他明明就在 Electron 里（甚至是打包版），真原因（凭据文件读失败、主进程 handler 抛）
     * 既不显示也不落日志。
     *
     * 现在两条路分开：
     *   · 没桥 → `BROWSER_PROVIDERS`（那句"请用 Electron 启动"是对的）；
     *   · 有桥但读失败 → `BRIDGE_FAILED_PROVIDERS`（说"读不到"，原文只进日志）。
     * 后者仍然是 `available:false`，所以路由那套不会挑中它（不会把故障伪装成可用通道）。
     */
    console.error("[ai] 通道列表读取失败：", error instanceof Error ? error.message : error);
    return BRIDGE_FAILED_PROVIDERS;
  }
}

/**
 * 「有桥，但主进程读取失败」时的占位列表（审计 P238）。
 *
 * 与 `BROWSER_PROVIDERS` **必须分开**：那个代表"根本没有 Electron 环境"，
 * 这个代表"在 Electron 里，但这次没读出来"。两者给用户的下一步完全不同
 * （一个去起 Electron，一个去重试/看日志）。
 *
 * `available:false` 是刻意的 —— 故障不许被路由逻辑当成一条可用通道。
 */
const BRIDGE_FAILED_PROVIDERS: ProviderInfo[] = [
  {
    id: "list-failed",
    label: "通道列表读不到",
    models: [],
    note: "主进程读取通道列表失败：重试一次；仍不行请看日志（原文不往界面上吐）",
    available: false,
    keyRef: "",
  },
];

export type ProbeRow = { id: string; ok: boolean; ms: number; error?: string };

/**
 * 主动探测各 provider 的真实连通性（较慢，只在用户需要时调）。
 *
 * ⚠️ 2026-10-16（审计 P240）两条如实记：
 *
 * ① **返回值区分了「探测跑了、一条都没成」与「探测根本没跑成」。**
 *    原来异常被吞成 `[]` —— 界面上与"没有任何结果"长得一模一样，
 *    用户点了探测像没点，且原文既不显示也不落日志。现在失败带 `error`，原文进日志。
 *
 * ② **这份渲染层封装现在没有任何界面在调它**（别以为摘掉它就等于砍功能）：
 *    设置·模型页上只有三颗按钮 —— 拉取模型清单 / 设为默认 / 保存密钥，
 *    **没有探测按钮**；`src/styles/chat.css` 里那句「探测按钮 + 还没验证过提示」
 *    是改版前的旧说法。真探测跑在主进程（`electron/ipc/aiProbe.ts` → `provider-probe.json`），
 *    设置页只**读**它记下的「已验证」状态。
 *    留着这个口子是因为它是"该有却断了"的那一端：谁把按钮接回来，返回值已经是诚实的。
 */
export async function probeProviders(): Promise<{ rows: ProbeRow[]; error?: string }> {
  const shell = bridge();
  if (!shell?.ai) return { rows: [], error: "AI 通道不可用（当前不在 Electron 里）" };
  try {
    return { rows: await shell.ai.probe() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "探测调用失败";
    console.error("[ai] 探测失败：", message);
    return { rows: [], error: message };
  }
}

/**
 * 用户点了「允许」→ 执行那一次被拦下的工具调用（§144）。
 *
 * 没有桥时返回一个**明确的失败**，而不是抛异常：界面要能显示"这台环境没法执行"，
 * 而不是整块崩掉。
 */
export async function runToolOnce(request: ToolRunRequest): Promise<ToolRunResult> {
  const shell = bridge();
  if (!shell?.ai?.runTool) {
    return { ok: false, error: "AI 通道不可用（当前不在 Electron 里）", line: "⚙ 无法执行：AI 通道不可用" };
  }
  try {
    return await shell.ai.runTool(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, line: `⚙ 执行失败：${message.slice(0, 60)}` };
  }
}

export type StreamHandle = {
  requestId: string;
  /** 中止这次请求（同时让返回的 Promise 以"已中止"收尾）。 */
  abort: () => void;
  /** 流结束时 resolve；`aborted` 为真表示是手动中止。 */
  done: Promise<{ aborted: boolean }>;
};

/**
 * 一次流里**多久收不到任何事件就算卡住**（2026-10-16，审计 P239）。
 *
 * 为什么必须有：`streamChat` 只在收到 `done`/`error` 或用户点中止时才收尾，
 * 而这条链上**一层超时都没有**（`electron/ipc/ai.ts` 只有 40ms 批量 flush 定时器、
 * `engine/runtime/loop.ts` 的 `streamText` 只传 `abortSignal`）。
 * 于是"TCP 连上了、provider 不再吐字节"（SSE 中途断、上游挂住）会让
 * `completeOnce` 的四处调用（画布 / 文档 ×2 / 智能体 / 任务）**永久停在「生成中」**，
 * 用户只能强杀应用；每卡一次还多留一个 `onStream` 监听器与一条 `liveStreams` 记录。
 *
 * 取值 60 秒：正常一轮的相邻事件间隔是毫秒级，60 秒静默只可能是断了。
 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * 发起一次流式对话。
 *
 * @param request provider / model / messages
 * @param onEvent 每个流事件（text / done / error）
 * @param opts.idleTimeoutMs 空闲看门狗（默认 `STREAM_IDLE_TIMEOUT_MS`；测试用小的值）
 * @returns 句柄：`requestId`、`abort`，以及**流结束才 resolve** 的 `done`
 */
export async function streamChat(
  request: ChatRequest,
  onEvent: (event: AiStreamEvent) => void,
  opts: { idleTimeoutMs?: number } = {},
): Promise<StreamHandle> {
  const shell = bridge();
  if (!shell?.ai) {
    const message = "AI 通道不可用：当前在浏览器里运行，请用 Electron 启动应用";
    onEvent({ requestId: "no-bridge", type: "error", message });
    return { requestId: "no-bridge", abort: () => undefined, done: Promise.resolve({ aborted: false }) };
  }

  const idleTimeoutMs = opts.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const buffered: AiStreamEvent[] = [];
  let requestId = "";
  let finished = false;
  let resolveDone: (value: { aborted: boolean }) => void = () => undefined;
  const done = new Promise<{ aborted: boolean }>((resolve) => {
    resolveDone = resolve;
  });

  /*
   * 空闲看门狗：每次有事件就重新计时；到点说明上游静默了 ——
   * 尽力 `abort`（拿不到 requestId 就只收尾），并把"卡住"变成一个**读得懂的失败**。
   * 不复位的话，一次卡住之后每 60 秒都会再响一次（`settle` 里有 `finished` 守卫，但它只挡一次收尾，不挡重复 `abort`）。
   */
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (finished) return;
      if (requestId) void shell.ai!.abort(requestId);
      settle(false, {
        requestId: requestId || "idle-timeout",
        type: "error",
        message: `上游 ${idleTimeoutMs >= 1000 ? Math.round(idleTimeoutMs / 1000) : (idleTimeoutMs / 1000).toFixed(2)} 秒没有回任何数据（连接可能已断）—— 已中止这次生成`,
      });
    }, idleTimeoutMs);
  };

  const settle = (aborted: boolean, event?: AiStreamEvent) => {
    if (finished) return;
    finished = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
    if (event) onEvent(event);
    unsubscribe();
    resolveDone({ aborted });
  };

  const dispatch = (event: AiStreamEvent) => {
    if (finished) return;
    armWatchdog();
    onEvent(event);
    if (event.type === "done") settle(false);
    else if (event.type === "error") settle(false);
  };

  const unsubscribe = shell.ai.onStream((raw) => {
    const event = raw as AiStreamEvent;
    // 订阅建立早于 requestId 返回，先把事件缓冲起来，拿到 id 后再补发
    if (!requestId) {
      buffered.push(event);
      return;
    }
    if (event.requestId !== requestId) return;
    dispatch(event);
  });

  /*
   * ⚠️ 看门狗**在请求发出之前就装上**：这样"主进程收到请求却一直不回 `requestId`"
   * 也会以超时收尾，而不是让调用方永远 await 下去。
   */
  armWatchdog();

  let started: ChatStartResult;
  try {
    started = await shell.ai.chat(request);
  } catch (error) {
    settle(false, {
      requestId: "ipc-error",
      type: "error",
      message: error instanceof Error ? error.message : "IPC 调用失败",
    });
    return { requestId: "ipc-error", abort: () => undefined, done };
  }

  requestId = started.requestId;
  if (!started.ok) {
    settle(false, { requestId, type: "error", message: started.error ?? "请求未能启动" });
    return { requestId, abort: () => undefined, done };
  }

  // 补发早到的事件
  for (const event of buffered) {
    if (event.requestId !== requestId) continue;
    dispatch(event);
    if (finished) break;
  }

  return {
    requestId,
    abort: () => {
      if (finished) return;
      void shell.ai.abort(requestId);
      settle(true, { requestId, type: "error", message: "已中止" });
    },
    done,
  };
}

/** 中止主进程里正在跑的某个请求（不关心本地回调时用）。 */
export async function abortStream(requestId: string): Promise<void> {
  const shell = bridge();
  if (!shell?.ai || !requestId) return;
  try {
    await shell.ai.abort(requestId);
  } catch {
    /* 请求可能已经结束 */
  }
}

/**
 * 便捷封装：把一段消息跑完再返回完整文本（画布生成走这条）。
 * @param request provider / model / messages / system
 * @param onDelta 每个增量（可选，用于边生成边显示）
 */
export async function completeOnce(
  request: ChatRequest,
  onDelta?: (text: string) => void,
): Promise<{ text: string; error?: string }> {
  let text = "";
  let error: string | undefined;
  try {
    const handle = await streamChat(request, (event) => {
      if (event.type === "text") {
        text += event.text;
        onDelta?.(event.text);
      } else if (event.type === "error") {
        error = event.message;
      }
    });
    // 等流真正结束，否则这里会拿着空串返回
    await handle.done;
  } catch (e) {
    // 编排层不该把异常吞掉：上层要靠 error 决定"生成失败"并给出原因
    error = e instanceof Error ? e.message : String(e);
  }
  return { text, error };
}

export type { ChatMessage, ChatRequest, ProviderInfo, AiStreamEvent };
