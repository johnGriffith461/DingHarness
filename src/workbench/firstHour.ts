import type { ShellBridge, SessionSummary } from "@shared/ipc";
import { firstHourOf, type FirstHourMetrics, type FirstHourRecord } from "@engine/core/firstHour";

/**
 * F-07：桌面侧读首小时指标（2026-10-20）。
 *
 * 这里只负责"挑哪段会话、怎么读"，**推导在 `engine/core/firstHour.ts`** ——
 * CLI 的 `ding stats --first-hour` 用的是同一个函数（同一实现，不许两份）。
 */

/**
 * 从会话列表里挑"最近一段任务/CLI 会话"。
 *
 * 不选聊天会话：聊天侧的记录里没有工作台的工具/审批流，拿它算"首小时确认次数"
 * 只会得到 0，看起来像"没问题"——那比没有数字更糟。
 */
export function pickFirstHourSession(sessions: readonly SessionSummary[]): SessionSummary | null {
  return (
    sessions.find((s) => s.sessionId.startsWith("task-") || s.sessionId.startsWith("cli-")) ?? null
  );
}

/**
 * 读最近一段任务会话的首小时指标。
 *
 * @returns 没有任务会话 / 没有日志通道时给 `null`（界面据此说"还没有可统计的会话"）。
 */
export async function loadFirstHour(): Promise<{ sessionId: string; metrics: FirstHourMetrics } | null> {
  const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
  if (!shell?.session) return null;
  let sessions: SessionSummary[] = [];
  try {
    sessions = await shell.session.list("all");
  } catch {
    return null;
  }
  const picked = pickFirstHourSession(sessions);
  if (!picked) return null;
  try {
    const loaded = await shell.session.load(picked.sessionId);
    return { sessionId: picked.sessionId, metrics: firstHourOf(loaded.records as FirstHourRecord[]) };
  } catch {
    return null;
  }
}

export { firstHourOf, type FirstHourMetrics, type FirstHourRecord };
