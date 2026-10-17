/**
 * **可续传的事件流**（G07，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 断网重连时，客户端只知道自己收到了第 N 帧 —— 如果服务端不回放 N 之后的部分，
 * 用户看到的就是"回答断了一截"（而且没有任何提示）。SSE 的 `Last-Event-ID`
 * 就是为这件事准备的，但**前提是服务端留着发过的帧**。
 *
 * 这个模块是那份"留着的帧"的纯逻辑：
 * - 每帧一个**单调递增的 seq**（客户端拿它做 `Last-Event-ID` / `after_seq`）；
 * - **重连回放**：给出 `after_seq`，返回之后的所有帧（不重复、不丢）；
 * - **按 attempt 丢弃旧段**：一次重试意味着前面的生成作废 ——
 *   只回放**当前 attempt** 的帧，旧段的半截正文不会与新的拼在一起；
 * - **有上限**：帧留太多会吃内存，超出就丢最旧的（并如实记 `dropped`）。
 *
 * ## 为什么 `transient` 帧不落进回放
 *
 * 进度类事件（"第 3 步"）只在当时有意义；重连时补发一堆过时的进度，
 * 客户端会显示"又跑了一遍"。只有 `durable`（正文/工具结果/收尾）需要回放。
 */

/** 一帧。 */
export type StreamFrame<T = unknown> = {
  seq: number;
  /** 第几次尝试（重试会 +1；旧 attempt 的帧不回放）。 */
  attempt: number;
  kind: "durable" | "transient";
  /** 帧名（SSE 的 `event:`）。 */
  event: string;
  data: T;
  at: number;
};

/** 一帧流的历史。 */
export type FrameLog<T = unknown> = {
  frames: StreamFrame<T>[];
  attempt: number;
  nextSeq: number;
  /** 因为上限被丢掉的帧数（如实记，不假装完整）。 */
  dropped: number;
  /** 这一轮结束了没有（结束之后不再接受新帧，但回放仍然可用）。 */
  done: boolean;
};

/** 默认保留多少帧（正文块 + 工具事件，2000 帧够一次长回答）。 */
export const FRAME_LIMIT = 2_000;

/** 建一份空日志。 */
export function createFrameLog<T = unknown>(): FrameLog<T> {
  return { frames: [], attempt: 1, nextSeq: 1, dropped: 0, done: false };
}

/**
 * 追加一帧（自动分配 seq）。
 *
 * @param log 日志（**原地改**，调用方持有它）
 * @param frame 帧（不带 seq/attempt/at 的那部分）
 * @param limit 上限（默认 2000）
 */
export function appendFrame<T>(
  log: FrameLog<T>,
  frame: { kind: StreamFrame<T>["kind"]; event: string; data: T },
  limit = FRAME_LIMIT,
): StreamFrame<T> {
  const stored: StreamFrame<T> = {
    seq: log.nextSeq,
    attempt: log.attempt,
    kind: frame.kind,
    event: frame.event,
    data: frame.data,
    at: Date.now(),
  };
  log.nextSeq += 1;
  log.frames.push(stored);
  if (log.frames.length > limit) {
    const cut = log.frames.length - limit;
    log.frames.splice(0, cut);
    log.dropped += cut;
  }
  return stored;
}

/**
 * 开始下一次尝试（重试）。
 *
 * 语义：`attempt + 1`，**之后的帧**属于新尝试；旧 attempt 的帧留着（审计用），
 * 但回放时不会被带出去。
 */
export function beginAttempt<T>(log: FrameLog<T>): number {
  log.attempt += 1;
  return log.attempt;
}

/**
 * 回放：`after_seq` 之后的帧。
 *
 * 三条过滤：
 * 1. 只要**当前 attempt** 的（旧段的半截正文不许拼进来）；
 * 2. 只要 `durable`（进度帧补发只会让客户端以为又跑了一遍）；
 * 3. `seq > after_seq`。
 *
 * @param log 日志
 * @param afterSeq 客户端最后收到的 seq（0 = 从头）
 */
export function framesAfter<T>(log: FrameLog<T>, afterSeq: number): StreamFrame<T>[] {
  const from = Number.isFinite(afterSeq) && afterSeq > 0 ? Math.floor(afterSeq) : 0;
  return log.frames.filter((f) => f.attempt === log.attempt && f.kind === "durable" && f.seq > from);
}

/**
 * 客户端能不能靠**这次回放**接上。
 *
 * 如果 `after_seq` 落在已被丢弃的区间里（客户端落后太多），回放给不出完整历史 ——
 * 这时要如实告诉它"接不上，请重开一轮"，而不是悄悄给一段缺头的正文。
 *
 * @param log 日志
 * @param afterSeq 客户端最后收到的 seq
 */
export function canResume<T>(log: FrameLog<T>, afterSeq: number): boolean {
  if (afterSeq <= 0) return log.dropped === 0;
  if (log.dropped === 0) return true;
  /* 丢过帧：只有 after_seq 在"最旧那一帧之前"才算完整 */
  const oldest = log.frames[0]?.seq ?? 0;
  return afterSeq >= oldest - 1;
}

/** 给客户端的一行说明（`canResume` 为假时用）。 */
export function resumeRefusal<T>(log: FrameLog<T>): string {
  return `这轮早于保留窗口的帧已经被丢掉（丢了 ${log.dropped} 帧）—— 从 after_seq 接不上，请重开一轮`;
}
