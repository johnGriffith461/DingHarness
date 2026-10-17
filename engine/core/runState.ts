import type { Actor } from "./actor";

/**
 * **运行状态机**（U01，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 在这之前，一段会话只有"跑了 / 完了 / 错了"三种隐含状态：状态是**从正文推出来的**，
 * 没有任何一处把它写下来。于是：
 *
 * - 进程被杀时，日志最后一行可能是半句正文 —— 重开之后看起来"正在跑"，
 *   实际上那个进程已经没有了（界面会一直转圈）；
 * - 审批被拦下时，"等我批"只活在那条工具留痕里，而不是一个**可恢复的运行态**；
 * - 预算/权限想让一次运行停下时，没有地方表达"暂停"。
 *
 * 现在：每次迁移写一条 `run-state` 记录（与审批决策同级的日志记录），
 * 状态可以从日志**回放**出来。这是"崩溃能恢复"的地基，不是 UI 装饰。
 *
 * ## 状态
 *
 * ```
 * IDLE → RUNNING → (WAITING_FOR_CONFIRMATION → RUNNING)*
 *                 → (PAUSED → RUNNING)?
 *                 → FINISHED | ERROR | STUCK
 * ```
 *
 * `STUCK` 是**看门狗**给的（模型长时间没有任何一块输出），不是错误：
 * 它可以恢复，错误不一定。
 *
 * ## 两条如实说明
 *
 * 1. **`WAITING_FOR_CONFIRMATION` 必须带 pending 明细**：只有状态名的话，
 *    重启之后用户看到"在等确认"却不知道在等哪一次调用 —— 那种状态比没有更糟。
 * 2. **冷启动只把 RUNNING 判死**：`RUNNING` 意味着"进程正握着它"，
 *    而重开时那个进程已经不在了 —— 所以它是 `ERROR`（带恢复入口）。
 *    `WAITING_FOR_CONFIRMATION` 与 `PAUSED` 是**用户可继续**的状态，不能判死。
 */

/** 运行态。 */
export const RUN_STATES = [
  "idle",
  "running",
  "waiting_for_confirmation",
  "paused",
  "finished",
  "error",
  "stuck",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** 状态的中文说明（CLI / 界面共用一份口径）。 */
export const RUN_STATE_LABEL: Record<RunState, string> = {
  idle: "空闲",
  running: "运行中",
  waiting_for_confirmation: "等你确认",
  paused: "已暂停",
  finished: "已完成",
  error: "出错",
  stuck: "卡住了",
};

/** 一条待确认的调用（WAITING_FOR_CONFIRMATION 的明细）。 */
export type RunPendingApproval = {
  toolCallId: string;
  name: string;
  /** 参数摘要（**不存全文**：它可能包含用户的正文）。 */
  summary?: string;
  /** 什么时候开始等的（epoch ms）。 */
  since: number;
  /** 过期时间（epoch ms）；超过之后这条待批不再可信。 */
  expiresAt?: number;
};

/** 审批默认有效期：10 分钟（与权限规则的 TTL 同一口径）。 */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** 状态迁移是在**同一轮**里发生的（新的一轮由 `beginTurn` 放行）。 */
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  idle: ["running"],
  running: ["waiting_for_confirmation", "paused", "finished", "error", "stuck"],
  waiting_for_confirmation: ["running", "paused", "error"],
  paused: ["running", "error"],
  stuck: ["running", "error"],
  finished: ["running", "idle"],
  error: ["running", "idle"],
};

/**
 * 这次迁移合不合法。
 *
 * @param from 当前态
 * @param to 目标态
 */
export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * 一个记录在案的状态迁移（写进日志的那个形状）。
 *
 * 与 `ApprovalRecord` 同一层：它不是流事件（没有 `requestId`），
 * 因为它可能在那一轮结束很久之后才写（用户去吃饭了，回来才批）。
 */
export type RunStateRecord = {
  seq: number;
  at: number;
  type: "run-state";
  state: RunState;
  /** 为什么切到这个状态（人话；给恢复界面用）。 */
  reason?: string;
  /** 只在 `waiting_for_confirmation` 时有。 */
  pending?: RunPendingApproval[];
  actor?: Actor;
};

/** 从磁盘读回来的记录（**磁盘不可信**）→ 干净的状态记录。 */
export function normalizeRunStateRecord(raw: Record<string, unknown>): RunStateRecord | null {
  const state = raw.state;
  if (typeof state !== "string" || !(RUN_STATES as readonly string[]).includes(state)) return null;
  if (typeof raw.seq !== "number" || typeof raw.at !== "number") return null;
  const out: RunStateRecord = {
    seq: raw.seq,
    at: raw.at,
    type: "run-state",
    state: state as RunState,
  };
  if (typeof raw.reason === "string" && raw.reason.trim()) out.reason = raw.reason;
  if (Array.isArray(raw.pending)) {
    const pending: RunPendingApproval[] = [];
    for (const item of raw.pending) {
      if (!item || typeof item !== "object") continue;
      const p = item as Record<string, unknown>;
      if (typeof p.toolCallId !== "string" || typeof p.name !== "string") continue;
      pending.push({
        toolCallId: p.toolCallId,
        name: p.name,
        ...(typeof p.summary === "string" ? { summary: p.summary } : {}),
        since: typeof p.since === "number" ? p.since : raw.at,
        ...(typeof p.expiresAt === "number" ? { expiresAt: p.expiresAt } : {}),
      });
    }
    if (pending.length) out.pending = pending;
  }
  return out;
}

/** 回放出来的运行态。 */
export type RunStateView = {
  state: RunState;
  /** 最近一次迁移的原因（没有就不编）。 */
  reason?: string;
  /** **还没处理**的待确认（已批/已拒的会被扣掉）。 */
  pending: RunPendingApproval[];
  /** 最近一次迁移的时刻。 */
  at?: number;
  /** 这是冷启动判死之后的态（`running` → `error`）。 */
  recovered?: "running";
};

/**
 * 从日志回放运行态。
 *
 * 两条口径：
 * - 只看 `run-state` 与 `approval` 两类记录（其余与状态无关）；
 * - `pending` 里**扣掉**已经有审批决策的 toolCallId（它们不再是"等你确认"）。
 *
 * @param records 日志记录（按 seq 升序）
 * @param opts.coldStart 是不是"进程刚起来"（只对 RUNNING 判死）
 */
export function foldRunState(
  records: ReadonlyArray<{
    type: string;
    seq?: number;
    at?: number;
    state?: unknown;
    reason?: unknown;
    pending?: unknown;
    toolCallId?: unknown;
  }>,
  opts: { coldStart?: boolean } = {},
): RunStateView {
  let state: RunState = "idle";
  let reason: string | undefined;
  let at: number | undefined;
  let pending: RunPendingApproval[] = [];
  const decided = new Set<string>();

  for (const record of records) {
    if (record.type === "approval" && typeof record.toolCallId === "string") {
      decided.add(record.toolCallId);
      continue;
    }
    if (record.type !== "run-state") continue;
    const normalized = normalizeRunStateRecord(record as Record<string, unknown>);
    if (!normalized) continue;
    state = normalized.state;
    reason = normalized.reason;
    at = normalized.at;
    pending = (normalized.pending ?? []).filter((p) => !decided.has(p.toolCallId));
  }
  /*
   * 审批决策可能排在状态记录**之后**（用户是过了一会儿才点的）——
   * 所以收尾再扣一次，不能只依赖上面那次过滤。
   */
  pending = pending.filter((p) => !decided.has(p.toolCallId));

  /*
   * 等确认但清单已空 = 审批都处理过了，只差"继续"。
   * 这时报"等你确认"会骗人（用户批完了却还看到按钮），所以降级成 `paused`。
   *
   * ⚠️ 只有**记录里确实带了 pending 字段**时才降级：旧日志/只写了状态名的记录
   * 没有清单，不能说"批完了"—— 那会把一个真实的待确认状态误报成可继续。
   */
  const hadPendingField = records.some((r) => r.type === "run-state" && Array.isArray(r.pending));
  if (state === "waiting_for_confirmation" && hadPendingField && pending.length === 0) {
    state = "paused";
    reason = "审批已处理，等待继续";
  }

  /*
   * 冷启动判死：`RUNNING` 意味着"进程正握着它"，而重开时那个进程已经不在了。
   * 这不是猜测 —— 同一个会话不可能被两个进程同时跑（存储层是单写者）。
   */
  if (opts.coldStart && state === "running") {
    return {
      state: "error",
      reason: "上一次运行没有正常结束（进程被杀或崩溃）；可以从最后一步继续",
      pending,
      ...(at === undefined ? {} : { at }),
      recovered: "running",
    };
  }

  return {
    state,
    ...(reason === undefined ? {} : { reason }),
    pending,
    ...(at === undefined ? {} : { at }),
  };
}

/**
 * 这一轮该记成什么收尾状态。
 *
 * @param input 收尾事实
 */
export function endStateOf(input: { ok: boolean; aborted?: boolean; pending: number }): {
  state: RunState;
  reason?: string;
} {
  if (input.aborted) return { state: "error", reason: "已中止" };
  if (input.pending > 0) return { state: "waiting_for_confirmation" };
  if (input.ok) return { state: "finished" };
  return { state: "error", reason: "这一轮以错误收尾" };
}
