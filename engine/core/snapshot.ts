import { splitTurns, type LogRecord, type TurnChunk } from "./events";

/**
 * 快照：**一段会话的投影**，用来做"行为不变"的验收（Phase 1 D6 的快照设施）。
 *
 * ## 它要替代什么
 *
 * 原来的回归手段是 99 条**点击**验收（`.verify/accept-*.mjs`）：启 Electron、
 * 点界面、量 DOM。那类验收有两个治不好的毛病：
 *   · **偶发**（等 300ms 不够就红），于是红了先怀疑测试而不是代码；
 *   · **量不到投影**（界面长什么样被量了，"这一轮到底投影出了什么"没有）。
 *
 * 事件流是确定性的：同样的记录进去，`splitTurns` 必须给出同样的东西。
 * 所以把"投影"本身当成被测对象 —— 这就是快照。
 *
 * ```
 * 旧版录一份 fixture（记录 + 当时的投影）
 * 新版拿同一份记录重放 → 逐轮 diff
 * ```
 *
 * ⚠️ **diff 为零才是通过**（不是"差不多"）。差出来了就是行为漂移，
 * 要么修代码，要么明确承认"这一处行为变了"再更新 fixture —— 并写清为什么。
 */

/** 一份快照。 */
export type Snapshot = {
  /** 格式版本（将来形状变了要能认出来，而不是把它当坏数据）。 */
  version: 1;
  sessionId: string;
  /** 录制的时刻（epoch ms）。 */
  recordedAt: number;
  /** 原始记录 —— **重放的输入**。 */
  records: LogRecord[];
  /** 录制时的投影 —— **重放的期望**。 */
  turns: TurnChunk[];
};

/**
 * 录一份快照（纯函数：给记录，给投影）。
 *
 * @param sessionId 会话 id
 * @param records 整段会话的记录
 * @param at 录制时刻（默认现在；测试里给固定值，好让 fixture 可比）
 * @returns 快照
 */
export function snapshotOf(sessionId: string, records: readonly LogRecord[], at = Date.now()): Snapshot {
  return { version: 1, sessionId, recordedAt: at, records: [...records], turns: splitTurns(records) };
}

/** 一份 diff 报告。 */
export type SnapshotDiff = {
  /** 逐轮比下来完全一致。 */
  equal: boolean;
  /** 给人看的差异（空数组 = 一致）。 */
  differences: string[];
};

/** 把一轮投影压成可比的短串（**比对的是内容，不是对象引用**）。 */
function turnSignature(chunk: TurnChunk): string {
  const view = chunk.view;
  const traces = view.traces.map((t) =>
    [t.toolCallId, t.name, t.ok ? "ok" : "fail", t.pending ? "pending" : "-", t.line].join("|"),
  );
  const usage = view.usage ? `${view.usage.inputTokens ?? "-"}/${view.usage.outputTokens ?? "-"}` : "-";
  return [
    `text=${JSON.stringify(view.text)}`,
    `done=${view.done}`,
    `error=${view.error ?? "-"}`,
    `usage=${usage}`,
    `traces=[${traces.join(" ; ")}]`,
  ].join(" ");
}

/**
 * 比两份快照。
 *
 * ⚠️ 比的是**记录数 + 逐轮投影**，不是"文件字节相同"：
 * 记录里带着时间戳与 `requestId`，字节比对会把"同一个行为、不同的时间"判成漂移。
 *
 * @param expected 期望（fixture）
 * @param actual 实际（重放出来的）
 * @returns 结论与差异清单
 */
export function diffSnapshot(expected: Snapshot, actual: Snapshot): SnapshotDiff {
  const differences: string[] = [];

  if (expected.records.length !== actual.records.length) {
    differences.push(`记录条数：期望 ${expected.records.length}，实际 ${actual.records.length}`);
  }
  if (expected.turns.length !== actual.turns.length) {
    differences.push(`轮数：期望 ${expected.turns.length}，实际 ${actual.turns.length}`);
  }

  const n = Math.min(expected.turns.length, actual.turns.length);
  for (let i = 0; i < n; i += 1) {
    const want = turnSignature(expected.turns[i]!);
    const got = turnSignature(actual.turns[i]!);
    if (want !== got) differences.push(`第 ${i + 1} 轮：\n    期望 ${want}\n    实际 ${got}`);
  }

  return { equal: differences.length === 0, differences };
}
