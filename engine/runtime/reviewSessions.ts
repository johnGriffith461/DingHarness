import { normalizeTaskSessionId } from "../core/events";

/**
 * T-01：改动审阅的读路径（**纯逻辑**，不碰 Electron）。
 *
 * ## 为什么需要它
 *
 * 会话身份统一之后，新数据一律写 `task-<id>`；但旧版本写的是**裸任务 id**。
 * 只读新会话 = 老用户的"改了什么 / 回滚"整片消失。
 * 所以：先读 `task-`，再补读裸 id，两者都有时合并去重。
 *
 * ⚠️ 这里只合并**记录**，不做任何 diff —— diff 与回滚仍在 `fileReview.ts`
 * （同一份实现，CLI 与桌面共用）。
 */

/** 审阅只关心这几种字段；用松类型避免把 IPC 的形状拖进内核。 */
export type RecordLike = {
  seq: number;
  at: number;
  type: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  [key: string]: unknown;
};

export type SessionLoader = (sessionId: string) => Promise<{ records: readonly RecordLike[] }>;

/** 去重键：工具事件按调用 id（同一轮的两条记录 id 相同但 type 不同），其余按类型 + 时间。 */
function keyOf(record: RecordLike): string {
  if (record.toolCallId) return `${record.type}:${record.toolCallId}`;
  return `${record.type}:${record.at}`;
}

/**
 * 读一次审阅要用的记录（新会话优先 + 旧会话兜底）。
 *
 * @param rawSessionId 界面/主进程给的会话 id（`task-x` 或裸 `x`）
 * @param load 读一整段会话（注入：桌面走 SQLite，测试给假实现）
 * @returns 合并后的记录（按 `at` 升序；同一条出现两次只留一份）
 */
export async function loadReviewRecords(rawSessionId: string, load: SessionLoader): Promise<RecordLike[]> {
  const normalized = normalizeTaskSessionId(rawSessionId);
  if (!normalized) return [];
  const bare = normalized.startsWith("task-") ? normalized.slice("task-".length) : "";
  const primary = await load(normalized);
  const fallback = bare && bare !== normalized ? await load(bare) : { records: [] };
  const merged = new Map<string, RecordLike>();
  /*
   * ⚠️ **旧数据先入**（按时间它在前），再放新的：同一 toolCallId 以新的为准
   * （新数据里那条带着用户决策后的真实 output）。
   */
  for (const record of [...fallback.records, ...primary.records]) merged.set(keyOf(record), record);
  return [...merged.values()].sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at - b.at));
}

/**
 * T-08：从会话记录里取**当初那个任务的运行目录**。
 *
 * `ding review <会话> --revert <文件>` 要知道白名单：那些文件当初是在哪个目录下改的。
 * 取**最后一条**带 `workdirs` 的 `request` 记录（同一个会话里目录可能变过，
 * 但回滚针对的是最近那次运行）。旧日志没有这个字段 → 返回空数组，调用方回落配置/cwd。
 */
export function workdirsFromRecords(records: readonly RecordLike[]): string[] {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (!record || record.type !== "request") continue;
    const dirs = record.workdirs;
    if (Array.isArray(dirs)) {
      const clean = dirs.filter((d): d is string => typeof d === "string" && d.trim() !== "").map((d) => d.trim());
      if (clean.length) return clean;
    }
  }
  return [];
}
