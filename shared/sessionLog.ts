import {
  SPAWN_AGENT_TOOL,
  blockedToTraces,
  describeToolResult,
  type ToolTrace,
} from "./agentTools";
import type { AiStreamEvent } from "./ipc";

/**
 * 会话事件日志 + **一轮对话的投影**（C2）。
 *
 * ## 这一层解决的是什么
 *
 * 原来"主进程发事件 → 渲染层各解析一遍"被实现了 **四遍**：工作台 `store.ts`、
 * 聊天 `chatStore.ts`、悬浮助手 `FloatingAssistant.tsx`，加上主进程自己构造事件那一处。
 * 四份代码要同时答对同一批问题：工具调用的**参数**怎么与结果配对、
 * 哪一条是"等你确认"（**没执行**）、界面那一行怎么写、用量从哪来。
 * 于是它们**慢慢答得不一样**（实测：工作台不接 `usage`、聊天不展开子智能体上交的调用）。
 *
 * 现在这些答案只有一份：**`applyEvent`**。
 * 它同时是"流式增量"与"日志投影"——
 *
 * ```
 * projectTurn(events)  =  finishTurn(events.reduce(applyEvent, emptyTurn()))
 * 流式那一侧           =  每来一条事件就 applyEvent 一次（同一个函数）
 * ```
 *
 * 同一条路算出来的东西，不可能两边不一致。
 *
 * ## 硬不变量（C2 的验收核心，见 `docs/PLAN-C2-Agent运行时收敛.md`）
 *
 * - **INV-1**：模型这一轮看见的内容必须能从会话日志重建 —— 所以日志记的是
 *   **事件本身**（含 `usage`、含工具的参数与输出），不是"渲染后的样子"。
 * - **INV-2**：同一段日志投影出来的东西，两条路径必须相同 —— 由本文件保证（只有一份实现）。
 * - **INV-3**：被拦下的动作要能从日志看出"它当时被拦了" —— `pending` 是投影里的一等字段。
 *
 * ⚠️ **本文件是纯逻辑**（不 import fs/electron）：主进程与渲染进程都 import 它，
 * 所以它必须能在 `pnpm test` 里被直接断言。
 */

/** 日志里的一条：流事件 + 它在会话里的位置。 */
export type LoggedEvent = AiStreamEvent & {
  /** 会话内单调递增（从 1 开始）。日志乱序/缺行时能自证。 */
  seq: number;
  /** 落日志的时刻（epoch ms）。 */
  at: number;
};

/**
 * 日志的**首行**：这一轮**模型实际看见的东西**。
 *
 * ## 为什么必须记它（INV-1 的落点）
 *
 * "模型看见的内容必须能从会话日志重建"——只记事件流是**不够**的：
 * 事件只说"模型回了什么、调了什么工具"，不说它**当时看着什么**回的
 * （系统提示词里有没有长期记忆？历史里那几条被折成了什么样？用的是哪个模型？）。
 * 而这些恰恰是事后最需要回答的问题（"它为什么不知道我早说过"）。
 *
 * ## 如实说明两点
 *
 * 1. **这是"记录"而不是"重建"**：请求原样落盘，所以此刻它当然可查。
 *    C3（上下文窗口单一负责人）/ C2-4（装配收敛）完成之后，装配变成
 *    **由日志可推导**的纯函数，那时这一行可以退化成"只记输入"
 *    （记忆库快照、人设 id）——在没有那一步之前**不许假装它已经能重建**。
 * 2. **历史会在每一轮重复落盘**（第 N 轮的请求里带着前 N-1 轮），
 *    所以单个会话的日志体积是**平方级**增长。本机版几十轮的量级（几百 KB）可接受；
 *    真到要瘦身时应当由 C3 统一决定（它管上下文，也就该管这份记录）。
 */
export type TurnRequest = {
  requestId: string;
  seq: number;
  at: number;
  type: "request";
  provider: string;
  model: string;
  /** 模型看见的 system（**原样**，主进程不加工）。 */
  system?: string;
  /** 模型看见的消息（旧 → 新）。 */
  messages: { role: string; content: string }[];
  toolPolicy?: string;
  useTools?: boolean;
};

/** 日志里可能出现的一条记录。 */
export type LogRecord = LoggedEvent | TurnRequest;

/**
 * 投影的输入：日志里的记录，或**还没落盘的**流事件。
 *
 * 后者是流式那一侧用的（事件先到界面、日志在同一个出口处顺手记）：
 * 同一个  两边都吃，这正是两边不会算出不同结果的落点。
 */
export type TurnInput = LogRecord | AiStreamEvent;

/**
 * 落盘前的记录：还没分配 `seq`/`at`。
 *
 * ⚠️ **必须用分配式 `Omit`**：`Omit<联合类型, K>` 只会留下各成员的**公共字段**，
 * 于是 `text` / `toolCallId` 这些都会被抹掉，调用方传什么都报"属性不存在"。
 * 这是 TypeScript 的既有行为（不是这里写错了），所以显式展开一遍联合。
 */
export type LogInput = LogRecord extends infer T ? (T extends LogRecord ? Omit<T, "seq" | "at"> : never) : never;

/**
 * 一轮对话的投影（**可显示/可落库的成品**）。
 *
 * 这是"这一轮发生了什么"的**唯一**说法：正文、工具、用量、成败。
 * 两条界面路径都从这个对象取值，不再各自解析事件流。
 */
export type TurnView = {
  /** 正文（原样累积，**含产物标签** —— 提取成卡片是界面的事，不属于"发生过什么"）。 */
  text: string;
  /** 工具调用的留痕（按发生顺序；`pending` 就是"被拦下了、还没执行"）。 */
  traces: ToolTrace[];
  /** 真实用量（provider 给的；拿不到就是 undefined —— **不编**）。 */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** 这一轮以错误收尾时的那句话（含"已中止"）。 */
  error?: string;
  /** 收到 `done`（或 `error`）—— 这一轮已经结束。 */
  done: boolean;
};

/**
 * 累积中的状态 = 成品 + **还没配对的调用**。
 *
 * ⚠️ 为什么要把"只有调用、还没结果"的那些单独放（而不是混进 `traces`）：
 * 一次工具调用是**两条事件**（`tool-call` 带参数、`tool-result` 带结果）。
 * 混进 `traces` 的话，流式途中界面上会闪出一条**空行**的留痕，
 * 而且每个调用方都得记得"显示前先过滤没结果的" —— 那是等着被漏掉的设计。
 * 放在这里之后，`traces` 永远是可显示的，不用谁记得。
 */
export type TurnState = TurnView & {
  /** 内部：等结果的调用（配对完就移出）。 */
  waiting: { toolCallId: string; name: string; input?: unknown }[];
};

/** 空白的一轮。 */
export function emptyTurn(): TurnState {
  return { text: "", traces: [], done: false, waiting: [] };
}

/**
 * 把一条流事件并进累积状态（**纯函数**：返回新对象，不改入参）。
 *
 * ## 这里做的每一项判断，都是从原来四份实现里收出来的
 *
 * | 判断 | 为什么必须只有一份 |
 * |---|---|
 * | 参数按 `toolCallId` 配对 | 放行时要**原样执行**那份参数；丢了就只能重问用户 |
 * | `pending` = "没执行" | 界面文案、历史折行、放行按钮都以它为准；判错会让用户以为事做完了 |
 * | `line` 由 `describeToolResult` 生成 | 界面那行小字与历史里那行**必须同一句话**（§144 的口径） |
 * | 子智能体上交的调用展开成待批准项 | 工作台做了、聊天没做 —— 那是**同一件事的两个答案**（见 `expandBlocked`） |
 *
 * ⚠️ 非流事件（`request`，见 `TurnRequest`）**原样跳过**：它是"输入记录"，
 * 不是"发生过的事"。拿它当事件用的后果是把它当成一次报错（原来那条"不是 text/done 就当 error"
 * 的兜底就是这么坏的）。
 *
 * @param state 上一步的状态
 * @param event 新事件（或日志里的输入记录）
 * @returns 新状态
 */
export function applyEvent(state: TurnState, event: TurnInput): TurnState {
  if (event.type === "request") return state;

  if (event.type === "text") return { ...state, text: state.text + event.text };

  if (event.type === "tool-call") {
    return {
      ...state,
      waiting: [
        ...state.waiting,
        {
          toolCallId: event.toolCallId,
          name: event.toolName,
          ...(event.input === undefined ? {} : { input: event.input }),
        },
      ],
    };
  }

  if (event.type === "tool-result") {
    const called = state.waiting.find((w) => w.toolCallId === event.toolCallId);
    const ok = !event.error;
    const pending = isPendingOutput(event.output);
    const trace: ToolTrace = {
      toolCallId: event.toolCallId,
      name: event.toolName,
      ok,
      line: describeToolResult(event.toolName, ok, event.output, event.error, called?.input),
      ...(pending ? { pending: true } : {}),
      ...(called?.input === undefined ? {} : { input: called.input }),
      ...(event.output === undefined ? {} : { output: event.output }),
      ...(event.error ? { error: event.error } : {}),
    };
    /*
     * ⭐ **按 `toolCallId` 幂等**：同一个 id 的结果第二次到达时是**替换**，不是再追加一条。
     *
     * 为什么这条必须成立：日志是追加写的，而追加会重试（`retryAsync`）——
     * 一次"写进去一半就失败"之后重试，可能让**同一条事件在日志里出现两次**。
     * 重放这种日志时，用户会看到同一个动作写了两行。按 id 幂等之后，
     * "事件重复"与"动作重复"就分开了：前者被吸收，后者本来就不会发生。
     */
    const seen = state.traces.findIndex((t) => t.toolCallId === event.toolCallId);
    const traces =
      seen >= 0 ? state.traces.map((t, i) => (i === seen ? trace : t)) : [...state.traces, trace];
    return {
      ...state,
      traces,
      // 配对掉了就从等待队列里移出（同一个 id 只配一次）
      waiting: state.waiting.filter((w) => w.toolCallId !== event.toolCallId),
    };
  }

  if (event.type === "done") {
    return { ...state, done: true, ...(event.usage ? { usage: event.usage } : {}) };
  }

  // error
  return { ...state, done: true, error: event.message };
}

/**
 * 这条工具输出是不是"被闸门拦下、**还没执行**"。
 *
 * 判据取自工具执行的返回形状（`electron/ipc/tools.ts` 的 `gated()`）：
 * `{ pending: true, notice }`。**只有 `=== true` 算**，别把别的东西误判成待确认 ——
 * 误判的后果是界面给一个假的"允许"按钮，或者把真待确认的当成已执行。
 *
 * @param output 工具输出
 * @returns 是否待用户确认
 */
export function isPendingOutput(output: unknown): boolean {
  return (output as { pending?: unknown } | null | undefined)?.pending === true;
}

export type ProjectOptions = {
  /**
   * 把子智能体上交的调用展开成**父级上的待批准留痕**（§176）。
   *
   * ⚠️ 这是一个**策略**开关，不是两套逻辑：展开用的 `blockedToTraces` 只有一份。
   * 现状：工作台开、聊天关 —— 那条差异记在 C2 方案的"两条路径差异"清单里
   * （统一它会让聊天多出可放行的按钮，属行为变更，单独决定）。
   */
  expandBlocked?: boolean;
};

/**
 * 收尾：把累积状态变成成品。
 *
 * - 只留在等待队列里的调用**不进 `traces`**（"调了一半"不是发生过的事）；
 * - 按策略展开子智能体上交的调用。
 *
 * 流式那一侧**每次要显示时都调它**（很便宜：一趟 filter），
 * 这样"什么时候显示"不会变成另一处要记的规矩。
 *
 * @param state 累积状态
 * @param opts 见 `ProjectOptions`
 * @returns 可显示/可落库的投影
 */
export function finishTurn(state: TurnState, opts: ProjectOptions = {}): TurnView {
  const { text, traces, usage, error, done } = state;
  const base: TurnView = {
    text,
    traces: [...traces],
    done,
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
  };
  if (!opts.expandBlocked) return base;
  const expanded: ToolTrace[] = [];
  for (const trace of traces) {
    expanded.push(trace);
    if (trace.name !== SPAWN_AGENT_TOOL || !trace.ok) continue;
    const report = trace.output as { blocked?: SubagentBlockedLike[] } | undefined;
    expanded.push(...blockedToTraces(report?.blocked));
  }
  return { ...base, traces: expanded };
}

/** `SubagentReport.blocked` 的形状（只取这里用得到的部分，避免多一处强类型耦合）。 */
type SubagentBlockedLike = { toolCallId: string; name: string; input?: unknown };

/**
 * 把一串记录投影成一轮（`applyEvent` 的折叠）。
 *
 * @param records 这一轮的记录（按发生顺序；`request` 记录会被跳过）
 * @param opts 见 `ProjectOptions`
 * @returns 投影
 */
export function projectTurn(records: readonly TurnInput[], opts: ProjectOptions = {}): TurnView {
  let state = emptyTurn();
  for (const record of records) state = applyEvent(state, record);
  return finishTurn(state, opts);
}

/* ────────────────────── 落盘：一行一条 ────────────────────── */

/**
 * 序列化成**一行**（换行结尾），供 `.jsonl` 追加。
 *
 * 为什么是 jsonl 而不是一个 JSON 数组：日志是**追加写**的。
 * 数组每次都要重写整个文件（越写越慢，而且写到一半崩掉就整段没了）；
 * 一行一条时，**坏掉的只是那一行**。
 *
 * @param record 要落的记录（流事件或输入记录）
 * @param seq 会话内的序号
 * @param at 时刻
 * @returns 一行文本
 */
export function logLine(record: LogInput, seq: number, at: number): string {
  return `${JSON.stringify({ seq, at, ...record })}\n`;
}

/** 解析一行；不合法返回 null（**调用方跳过它，不放弃整段**）。 */
export function parseLogLine(line: string): LogRecord | null {
  const text = line.trim();
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.seq !== "number" || typeof o.at !== "number") return null;
  if (typeof o.requestId !== "string" || typeof o.type !== "string") return null;
  if (o.type === "request") {
    // 输入记录：必须真带着消息数组（不然"模型看见过什么"是空的）
    if (!Array.isArray(o.messages)) return null;
    return o as TurnRequest;
  }
  const known = ["text", "tool-call", "tool-result", "done", "error"];
  if (!known.includes(o.type)) return null;
  return o as LoggedEvent;
}

/**
 * 解析整段日志。
 *
 * ⚠️ **坏行只跳过它自己**：日志是"发生过什么"的记录，一行写入被打断
 * （断电、强杀进程）不该让整段历史消失。跳过的行数**报出来**，不静默吞。
 *
 * @param text 整个 `.jsonl` 文件的内容
 * @returns 记录（按 `seq` 升序）与坏行数
 */
export function parseLog(text: string): { records: LogRecord[]; skipped: number } {
  const records: LogRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseLogLine(line);
    if (parsed) records.push(parsed);
    else skipped += 1;
  }
  records.sort((a, b) => a.seq - b.seq);
  return { records, skipped };
}
