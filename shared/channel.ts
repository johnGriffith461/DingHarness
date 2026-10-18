/**
 * **渠道会话 id**（原在 `hosts/server/channelApi.ts`，L 系列收进 shared）。
 *
 * 为什么搬：IM 桥（`engine/im`）也要算出"这条消息属于哪段会话" —— 它要在
 * 一轮结束后按会话查待批。引擎不许 import 宿主（`AGENTS.md` 的架构规矩），
 * 所以这段纯函数只能在 `shared/`，两边各引同一份。
 */

/** 渠道会话 id（同一渠道同一个人一段会话）。 */
export function channelSessionId(channel: string, from: string): string {
  const safe = (x: string) => x.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `ch-${safe(channel)}-${safe(from)}`;
}

/**
 * 从会话 id 里认回"外面那个人"（账本与审计那侧用）。
 *
 * @param sessionId 会话 id
 * @returns `渠道:发送者`；不是渠道会话给 null
 */
export function endUserFromSessionId(sessionId: string): { channel: string; endUser: string } | null {
  const m = /^ch-([A-Za-z0-9._-]+)-([A-Za-z0-9._-]+)$/.exec(sessionId);
  if (!m) return null;
  return { channel: m[1]!, endUser: m[2]! };
}
