import {
  resumeSession,
  type LogInput,
  type LogRecord,
  type ResumedSession,
} from "./core/events";
import { diffSnapshot, snapshotOf, type Snapshot, type SnapshotDiff } from "./core/snapshot";
import type { ExecutorContext, ToolExecutor } from "./ports/executor";
import type { HealthStore } from "./ports/health";
import { noopHealth } from "./ports/health";
import type { SessionStore } from "./ports/store";
import type { ConfirmMode } from "../shared/ipc";
import {
  buildToolSet,
  createToolRegistry,
  offeredToolNames,
  type ToolEntry,
  type ToolRegistry,
} from "./runtime/registry";
import { runTurn, type TurnEvent } from "./runtime/loop";

/**
 * 内核的公开 API（Phase 1 D1 冻结）。
 *
 * ## 这一层的职责只有一件：**把端口和内核装配起来**
 *
 * 在这之前，"跑一轮"这件事的装配散在两个宿主里各写一遍：桌面在
 * `electron/ipc/ai.ts`（建工具集、写会话日志、补 requestId、记 provider 健康、
 * 合批发事件），CLI 则根本没有。于是"引擎"只是几个能被 import 的函数 ——
 * 谁的装配漏了一步，谁的 agent 就少一样能力（子智能体点停不停那件事就是这么来的）。
 *
 * 现在装配只有一份：**宿主给端口，内核给行为**。
 *
 * ```
 * const engine = createEngine({ store, executor, health });
 * const out = await engine.run({ sessionId, provider, messages, mode: "按需确认" });
 * ```
 *
 * ## 三条不变量在这份文件里的落点
 *
 * | 不变量 | 落点 |
 * |---|---|
 * | 状态 = fold(events) | `resume()`：读记录 → `resumeSession` 投影，**没有第二份"翻译回消息列表"** |
 * | 日志即真相 | `run()` 里**发事件与记日志同一个出口**（`record()`） |
 * | 错误即结果 | `run()` 不因为工具失败/未知工具/闸门拦截而中断 —— 那些都是 tool result |
 */

/** 宿主提供给内核的东西（四个，缺一不可，只有 health 可以省）。 */
export type EnginePorts = {
  /** 会话事件的持久化。 */
  store: SessionStore;
  /** 工具执行体（宿主绑定真实工具）。 */
  executor: ToolExecutor;
  /** provider 健康账本（省略 = 不记）。 */
  health?: HealthStore;
  /** 额外的工具来源（MCP 工具 / Phase 8 的插件工具）。 */
  tools?: readonly ToolEntry[];
};

/** 跑一轮的请求。 */
export type EngineRunRequest = {
  /** 这一轮属于哪段会话（宿主决定：工作台给任务 id、聊天给对话 id）。 */
  sessionId: string;
  provider: string;
  model?: string;
  system?: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  /** 闸门档位。 */
  mode: ConfirmMode;
  /** 给不给工具（起标题、翻译这类附带请求不给 —— 它们拿到工具会真的动手）。 */
  useTools?: boolean;
  /** 步数上限（父 4 / 子 6 是各自的经验值，作为参数传进来）。 */
  maxSteps?: number;
  abortSignal?: AbortSignal;
};

/** 一轮的结局。 */
export type EngineRunResult = {
  ok: boolean;
  error?: string;
  aborted: boolean;
  provider: string;
  model: string;
  /** 这一轮吐出的事件（宿主拿去上屏；快照设施拿去落 fixture）。 */
  events: TurnEvent[];
  /** 这一轮落盘的记录（含首行 `request`）。 */
  records: LogRecord[];
  /** 这一次请求的 id（宿主按它归并流片段）。 */
  requestId: string;
};

export type Engine = {
  /** 跑一轮，并把这一轮完整记进会话日志。 */
  run(request: EngineRunRequest): Promise<EngineRunResult>;
  /** 从日志还原一段会话（重启之后把界面恢复到"那一刻的样子"）。 */
  resume(sessionId: string): Promise<ResumedSession>;
  /** 重放一份快照并与它自己录下来的投影 diff（快照验收的执行器）。 */
  replay(fixture: Snapshot): Promise<SnapshotDiff>;
  /** 录一份快照（把一段会话的记录与投影一起存下来）。 */
  record(sessionId: string): Promise<Snapshot | null>;
  /** 注册表（`ding models` / 插件页要列工具时用）。 */
  tools: ToolRegistry;
};

/**
 * 建一个引擎。
 *
 * ⚠️ **不在这里读任何全局路径**：数据放哪、密钥从哪来、工具落到哪个目录，
 * 全是宿主给端口时决定的事。这正是"桌面与 CLI 平权"在工程上的含义 ——
 * 内核没有"当前是哪个宿主"这个概念。
 *
 * @param ports 见 `EnginePorts`
 * @returns 引擎
 */
export function createEngine(ports: EnginePorts): Engine {
  const health = ports.health ?? noopHealth;
  const registry = createToolRegistry({ extra: ports.tools ?? [] });

  return {
    tools: registry,

    async run(request: EngineRunRequest): Promise<EngineRunResult> {
      const requestId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const records: LogRecord[] = [];

      /** 落一条记录（**发事件与记日志是同一个出口** —— 两处各写一份必然漂移）。 */
      const record = async (record: LogInput): Promise<void> => {
        const stored = await ports.store.append(request.sessionId, [record]);
        records.push(...stored);
      };

      /*
       * 首行：这一轮**模型实际看见了什么**（不变量 1）。
       * `tools` 记的是"够得着什么" —— 只记"用没用工具"事后回答不了
       * "新加的工具到底有没有下发"。
       */
      await record({
        requestId,
        type: "request",
        provider: request.provider,
        model: request.model ?? "",
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        toolPolicy: request.mode,
        ...(request.useTools ? { useTools: true } : {}),
        tools: request.useTools ? offeredToolNames(registry, request.mode, 0) : [],
      });

      const ctx: ExecutorContext = {
        mode: request.mode,
        provider: request.provider,
        ...(request.model ? { model: request.model } : {}),
        ...(request.abortSignal ? { signal: request.abortSignal } : {}),
        depth: 0,
      };

      const events: TurnEvent[] = [];
      const outcome = await runTurn(
        {
          provider: request.provider,
          ...(request.model ? { model: request.model } : {}),
          ...(request.system ? { system: request.system } : {}),
          messages: request.messages,
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
          ...(request.useTools
            ? {
                tools: buildToolSet({ registry, mode: request.mode, executor: ports.executor, ctx }),
                maxSteps: request.maxSteps ?? 4,
              }
            : {}),
        },
        (event) => {
          events.push(event);
          /*
           * ⚠️ `step-finish` **不落盘**：它只用来数步数，不改变正文/工具/用量。
           * 落进去的后果不是"多一条记录"—— 是 `parseLogLine` 不认它，读回时被算成**坏行**，
           * 于是日志里凭空多出一堆"坏行"（把一个空事件记成了数据损坏）。
           */
          if (event.type === "step-finish") return;
          /*
           * ⚠️ 事件是**同步**出口（`runTurn` 的契约），而落盘是异步的。
           * 所以这里排队而不是 await：`runTurn` 内部不能等磁盘 ——
           * 等它会让"模型吐字"被磁盘 IO 拖住。顺序由 store 自己保证（它的 append 是串行的）。
           */
          void record({ requestId, ...event } as LogInput);
        },
        { health },
      );

      /*
       * 中止：**记一条终止记录，不发事件**（与桌面那边一致）——
       * 否则读日志的人分不清"这一轮断了"还是"这一轮还在跑"。
       */
      if (outcome.aborted) {
        await record({ requestId, type: "error", message: "已中止" });
      }

      return {
        ok: outcome.ok,
        ...(outcome.error ? { error: outcome.error } : {}),
        aborted: outcome.aborted,
        provider: outcome.provider,
        model: outcome.model,
        events,
        records,
        requestId,
      };
    },

    async resume(sessionId: string): Promise<ResumedSession> {
      const { records } = await ports.store.load(sessionId);
      return resumeSession(records);
    },

    async record(sessionId: string): Promise<Snapshot | null> {
      const { records } = await ports.store.load(sessionId);
      if (!records.length) return null;
      return snapshotOf(sessionId, records);
    },

    async replay(fixture: Snapshot): Promise<SnapshotDiff> {
      /*
       * 重放 = 拿 fixture 里的**记录**再投影一遍，与被录下来的投影比。
       * 投影是纯函数，所以这一步不碰网络、不碰模型 —— 它证明的是
       * "同样的记录，投影给出的东西一字不差"，也就是重构零漂移。
       */
      return diffSnapshot(fixture, snapshotOf(fixture.sessionId, fixture.records, fixture.recordedAt));
    },
  };
}
