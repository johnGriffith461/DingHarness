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
  } catch {
    return BROWSER_PROVIDERS;
  }
}

/** 主动探测各 provider 的真实连通性（较慢，只在用户需要时调）。 */
export async function probeProviders(): Promise<
  Array<{ id: string; ok: boolean; ms: number; error?: string }>
> {
  const shell = bridge();
  if (!shell?.ai) return [];
  try {
    return await shell.ai.probe();
  } catch {
    return [];
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
 * 发起一次流式对话。
 *
 * @param request provider / model / messages
 * @param onEvent 每个流事件（text / done / error）
 * @returns 句柄：`requestId`、`abort`，以及**流结束才 resolve** 的 `done`
 */
export async function streamChat(
  request: ChatRequest,
  onEvent: (event: AiStreamEvent) => void,
): Promise<StreamHandle> {
  const shell = bridge();
  if (!shell?.ai) {
    const message = "AI 通道不可用：当前在浏览器里运行，请用 Electron 启动应用";
    onEvent({ requestId: "no-bridge", type: "error", message });
    return { requestId: "no-bridge", abort: () => undefined, done: Promise.resolve({ aborted: false }) };
  }

  const buffered: AiStreamEvent[] = [];
  let requestId = "";
  let finished = false;
  let resolveDone: (value: { aborted: boolean }) => void = () => undefined;
  const done = new Promise<{ aborted: boolean }>((resolve) => {
    resolveDone = resolve;
  });

  const settle = (aborted: boolean, event?: AiStreamEvent) => {
    if (finished) return;
    finished = true;
    if (event) onEvent(event);
    unsubscribe();
    resolveDone({ aborted });
  };

  const dispatch = (event: AiStreamEvent) => {
    if (finished) return;
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
