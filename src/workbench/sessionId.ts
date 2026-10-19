/**
 * T-01：任务会话 id 的归一化 —— **实现住内核**（`engine/core/events.ts`）。
 *
 * 这里只做转出，理由有两条：
 * 1. 前缀常量 `SESSION_PREFIX` 本来就住那里（`taskSessionId` 也在）；
 * 2. 审阅读路径（`engine/runtime/reviewSessions.ts`）也要用它 ——
 *    而内核**不许** import `src/`（分层纪律），所以实现只能在内核，这里转出。
 */

export { bareTaskId, normalizeTaskSessionId } from "@engine/core/events";
