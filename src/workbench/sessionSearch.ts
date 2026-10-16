import type { SessionSearchHit, ShellBridge } from "@shared/ipc";

/**
 * 左栏搜索的**渲染侧逻辑**（2026-10-17，V5 开工前清尾 #3）。
 *
 * 那颗搜索键原来是个**装饰**（title 自己写着"本机版是装饰：仿浏览器工具条"、`disabled`）。
 * 现在接 Phase 12.4 的会话全文检索（store 层 FTS + LIKE 并集，经 `session:search` 上来）。
 *
 * 纯逻辑抽在这里：组件那一层在这个仓里没有渲染环境（vitest 是 node），
 * 能测的就这几件事（回归见 `sessionSearch.test.ts`）：
 *   · 桥不可用 / 抛错时不假装；
 *   · 命中能不能**打开成任务**（`task-<id>` 且任务还在）；
 *   · 命中的种类标签（任务 / 命令行 / 对话 —— 后两种本机版没有查看页）。
 */

/** 桥（浏览器里跑就没有）。取法与 `src/ai/route.ts` 同一份。 */
function bridge(): ShellBridge | undefined {
  return (globalThis as unknown as { shell?: ShellBridge }).shell;
}

/** 检索会话。空查询 = 空结果（不是"全部"）；桥不可用/抛错都如实回报，不静默。 */
export async function searchSessions(
  query: string,
): Promise<{ ok: true; hits: SessionSearchHit[] } | { ok: false; error: string }> {
  const q = query.trim();
  if (!q) return { ok: true, hits: [] };
  const shell = bridge();
  if (typeof shell?.session?.search !== "function") {
    return { ok: false, error: "检索需要在应用里运行（当前环境没有会话库）" };
  }
  try {
    return { ok: true, hits: await shell.session.search(q) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 命中能不能打开成工作台任务。
 *
 * ⚠️ 两种会话 id 形态都要认（**这是一处已知的不一致**，2026-10-17 实测撞见）：
 *   · `task-<任务 id>` —— 审批留痕那条路用的是它（`store.ts` 经 `taskSessionId()`）；
 *   · **裸任务 id** —— 工作台一轮对话的记录用的是它（`taskRuntime` 的 `sessionId`
 *     就是任务 id，注释也这么写）。
 * 也就是说**同一个任务的两类记录会落在两个会话里**（任务有审批时可见两条命中）。
 * 这属于 V5-1 的会话身份题（C1：会话归属），该统一；在那之前这里两种都认，
 * 别让"搜得到却点不开"成为用户的困惑。
 *
 * @param hit 一条命中
 * @param hasTask 这个任务 id 现在还在不在工作台里
 * @returns 能打开就给任务 id；否则 `null`（只能看片段 —— 命令行记录本机版没有查看页）
 */
export function openableTaskId(
  hit: Pick<SessionSearchHit, "sessionId">,
  hasTask: (id: string) => boolean,
): string | null {
  const sessionId = hit.sessionId;
  const bare = sessionId.startsWith("task-") ? sessionId.slice("task-".length) : sessionId;
  return bare && hasTask(bare) ? bare : null;
}

/** 命中属于哪一类（给人看的小标签）。前缀语义取自 `engine/core/events.ts` 的 `SESSION_PREFIX`。 */
export function hitKindLabel(sessionId: string): string {
  if (sessionId.startsWith("task-")) return "任务";
  if (sessionId.startsWith("cli-")) return "命令行";
  if (sessionId.startsWith("chat-")) return "对话";
  return "记录";
}
