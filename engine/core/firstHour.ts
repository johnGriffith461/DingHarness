/**
 * 首小时指标（F-07，2026-10-20）。
 *
 * ## 为什么要它
 *
 * "第一小时有没有变好"这件事，现在没有任何可观察的数：确认了几次、等了多久、
 * 完成声明有没有证据、卸载前最后发生了什么。没有基线就只能靠感觉，
 * 而"感觉好多了"不是验收。
 *
 * ## 两条硬约束
 *
 * 1. **不新增事件类型**（事件溯源是地基）：所有数字都从**已有的会话日志**推导
 *    （`request` / `tool-call` / `tool-result` / `approval` / `error` / `finish`）；
 * 2. **不上报**：这是本机推导，界面与 `ding stats --first-hour` 读同一份实现。
 *
 * ## 如实说明
 *
 * `installToFirstTaskMs` 需要"安装时刻"，日志里没有这一格 —— 所以它是
 * `undefined`（不编一个"从第一条日志算起"的数字冒充安装时刻）。
 *
 * ## 为什么住在 engine/core 而不是 shared
 *
 * "这一条是不是待确认"只有一个判据：`events.ts` 的 `isPendingOutput`。
 * 本模块要数"问了几次确认"，就必须用**那一个**判据；而 `shared/` 不依赖内核。
 * 放在这里之后，桌面（`src/workbench/firstHour.ts`）与 CLI 都从同一份实现取值。
 */

import { isPendingOutput } from "./events";

/** 一条会话记录（磁盘读回来的，**不可信**；只认下面用到的那几个字段）。 */
export type FirstHourRecord = {
  type?: unknown;
  at?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
  approved?: unknown;
  message?: unknown;
  error?: unknown;
  /** 其余字段（`seq` / `requestId` / usage …）不参与推导，原样留着。 */
  [key: string]: unknown;
};

export type FirstHourMetrics = {
  /** 安装 → 第一个任务（日志里没有安装时刻时为 undefined，不编）。 */
  installToFirstTaskMs?: number;
  /** 第一条 `request` 的时刻。 */
  firstTaskStartedAt?: number;
  /** 一共问了几次确认（`tool-result` 里 `output.pending === true` 的条数）。 */
  confirmations: number;
  /** 其中**同一条命令**重复问的次数（签名重复出现）。 */
  repeatedCommandAsks: number;
  /** 用户在待确认上花掉的总时长（有审批记录的才计；没有记录的不猜）。 */
  awaitingTotalMs: number;
  /** 带证据（`finish.evidence.commands` 非空）的完成声明。 */
  doneWithEvidence: number;
  /** 不带证据的完成声明。 */
  doneWithoutEvidence: number;
  /** 出错按类分：auth / model / rate_limit / timeout / network / tool / other。 */
  errorsByKind: Record<string, number>;
  /** 最后 5 条事件的形状（`type` 或 `type:tool`）—— "卸载前最后发生了什么"。 */
  lastEventsBeforeQuit: string[];
};

/** 稳定 JSON（键排序、递归）—— 同一份参数换个键顺序不算两次。 */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

function timeOf(record: FirstHourRecord): number | null {
  return typeof record.at === "number" && Number.isFinite(record.at) ? record.at : null;
}

/** 错误分到哪一类（只按**已有的**文字分，不猜）。 */
export function classifyError(message: string): string {
  const text = String(message ?? "");
  if (/api[_ ]?key|密钥|credential|401|unauthorized|invalid.*key/i.test(text)) return "auth";
  if (/rate.?limit|429|限流|too many requests/i.test(text)) return "rate_limit";
  if (/timeout|timed out|超时|ETIMEDOUT|AbortError/i.test(text)) return "timeout";
  if (/model|模型|404|not found/i.test(text)) return "model";
  if (/network|fetch failed|ECONN|ENOTFOUND|socket|网络/i.test(text)) return "network";
  return "other";
}

/**
 * 从一段会话的原始记录推导首小时指标。
 *
 * @param records 会话记录（顺序不限；内部按 `at`/`seq` 排）
 */
export function firstHourOf(records: readonly FirstHourRecord[]): FirstHourMetrics {
  const sorted = [...records].sort((a, b) => {
    const ta = timeOf(a) ?? 0;
    const tb = timeOf(b) ?? 0;
    if (ta !== tb) return ta - tb;
    const sa = typeof (a as { seq?: unknown }).seq === "number" ? (a as { seq: number }).seq : 0;
    const sb = typeof (b as { seq?: unknown }).seq === "number" ? (b as { seq: number }).seq : 0;
    return sa - sb;
  });

  let firstTaskStartedAt: number | undefined;
  let repeatedCommandAsks = 0;
  let awaitingTotalMs = 0;
  let doneWithEvidence = 0;
  let doneWithoutEvidence = 0;
  const errorsByKind: Record<string, number> = {};

  /** toolCallId → 那次调用的签名（名字 + 参数）与发起时刻 */
  const calls = new Map<string, { signature: string; at: number | null }>();
  /**
   * **问过确认的调用 id**（去重后就是确认次数）。
   *
   * 两个来源，因为两条宿主路径留痕方式不同：
   * - 桌面：被拦下时落一条 `pending` 的 tool-result；
   * - CLI 就地审批：没有 pending 那一步，但引擎在用户答完时补一条 `approval`。
   * 同一个 id 同时命中两边时只算一次。
   */
  const askedIds = new Set<string>();
  /** 待确认 → 审批时刻（用于算等待时长）。 */
  const pendingAt = new Map<string, number>();
  const approvals = new Map<string, number>();

  const bump = (kind: string): void => {
    errorsByKind[kind] = (errorsByKind[kind] ?? 0) + 1;
  };

  for (const record of sorted) {
    const type = typeof record.type === "string" ? record.type : "";
    const at = timeOf(record);

    if (type === "request" && firstTaskStartedAt === undefined && at !== null) firstTaskStartedAt = at;

    if (type === "tool-call") {
      const id = typeof record.toolCallId === "string" ? record.toolCallId : "";
      const name = typeof record.toolName === "string" ? record.toolName : "";
      if (id) calls.set(id, { signature: `${name}:${stable(record.input ?? null)}`, at });
      if (name === "finish") {
        const input = record.input;
        const evidence = input && typeof input === "object" ? (input as { evidence?: unknown }).evidence : undefined;
        const commands =
          evidence && typeof evidence === "object" ? (evidence as { commands?: unknown }).commands : undefined;
        if (Array.isArray(commands) && commands.some((c) => typeof c === "string" && c.trim())) doneWithEvidence += 1;
        else doneWithoutEvidence += 1;
      }
    }

    /* 判据只认 `isPendingOutput` —— 与投影同一个实现，不在这里再写一遍 */
    if (type === "tool-result" && isPendingOutput(record.output)) {
      const id = typeof record.toolCallId === "string" ? record.toolCallId : "";
      if (id) askedIds.add(id);
      if (id && at !== null) pendingAt.set(id, at);
    }

    if (type === "approval") {
      const id = typeof record.toolCallId === "string" ? record.toolCallId : "";
      if (id) {
        askedIds.add(id);
        if (at !== null) approvals.set(id, at);
      }
    }

    if (type === "error") {
      bump(classifyError(typeof record.message === "string" ? record.message : ""));
    }
    if (type === "tool-result" && typeof record.error === "string" && record.error.trim()) {
      /* 工具失败与"通道失败"分开：前者是 agent 业务，后者是用户要修的路 */
      const kind = classifyError(record.error);
      bump(kind === "other" ? "tool" : kind);
    }
  }

  /*
   * 确认次数 = 问过的**去重 id**；重复问 = 同一签名（名字+参数）在问过的 id 里再次出现。
   * 顺序按"什么时候问的"（没有 pending 时刻的 CLI 就地审批用 tool-call 的时刻）。
   */
  const askedOrder = [...askedIds].sort((a, b) => {
    const ta = pendingAt.get(a) ?? calls.get(a)?.at ?? approvals.get(a) ?? 0;
    const tb = pendingAt.get(b) ?? calls.get(b)?.at ?? approvals.get(b) ?? 0;
    return ta - tb;
  });
  const seenSignatures = new Set<string>();
  for (const id of askedOrder) {
    const signature = calls.get(id)?.signature ?? "";
    if (!signature) continue;
    if (seenSignatures.has(signature)) repeatedCommandAsks += 1;
    else seenSignatures.add(signature);
  }
  const confirmations = askedIds.size;

  for (const id of askedOrder) {
    const end = approvals.get(id);
    const start = pendingAt.get(id) ?? calls.get(id)?.at ?? undefined;
    if (end !== undefined && start !== undefined && end >= start) awaitingTotalMs += end - start;
  }

  const lastEventsBeforeQuit = sorted.slice(-5).map((record) => {
    const type = typeof record.type === "string" ? record.type : "unknown";
    const tool = typeof record.toolName === "string" && record.toolName ? `:${record.toolName}` : "";
    return `${type}${tool}`;
  });

  return {
    firstTaskStartedAt,
    confirmations,
    repeatedCommandAsks,
    awaitingTotalMs,
    doneWithEvidence,
    doneWithoutEvidence,
    errorsByKind,
    lastEventsBeforeQuit,
  };
}
