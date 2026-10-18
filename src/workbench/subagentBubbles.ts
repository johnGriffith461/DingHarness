import {
  SPAWN_AGENT_TOOL,
  SPAWN_AGENTS_TOOL,
  blockedToTraces,
  type SubagentBlocked,
  type ToolTrace,
} from "@shared/agentTools";

/**
 * **子智能体被拦下的动作 → 父级的待批留痕**（G11 的接线，2026-10-18）。
 *
 * ## 之前的状态（为什么它是一条缺陷）
 *
 * `shared/agentTools.ts` 早就写好了 `blockedToTraces()`：把子智能体报告里的
 * `blocked` 变成父级步上 `pending: true` 的留痕。**但全仓没有一处调用它** ——
 * 于是子智能体被闸门拦下的动作只躺在 `spawn_agent` 的工具结果里（一句摘要），
 * 用户**看不到、也批不了**。这正是本仓一直在清的那类"写了、没接"。
 *
 * ## 现在的行为
 *
 * 父级这一步跑完、投影出工具留痕之后，把 `spawn_agent` / `spawn_agents` 结果里的
 * `blocked[]` 展开成**同一步上的待批行**：
 *
 * - 每一行都有 `input`（模型当时给的那份参数）与子智能体的 `toolCallId`；
 * - 用户点「允许」→ 现有 `resolveTool` 拿 name+input **在父级执行一次**
 *   （不再经过闸门 —— 那正是"用户已批准"的含义）；
 * - 点「拒绝」→ 只留痕，不执行。
 *
 * ## 两条边界（如实记）
 *
 * 1. **只在界面层展开**：这些行不是事件日志里的事件 —— 重启之后待批行不会自己回来
 *    （`spawn_agent` 的结果仍在日志里，但"点过没有"要看 approval 记录）。
 *    要做到重启仍在，得让投影认识这个展开（那会改动 `applyEvent` 的契约，代价大于收益）；
 * 2. **一条子智能体动作只冒一次**：同 `toolCallId` 已有的行不重复追加
 *    （一轮里多个 `spawn_agent` 可能带同一个子调用？不会，但别让重复行把界面撑爆）。
 */

/** 从一次工具结果里抠出 `blocked[]`（两种报告形状都认）。 */
function blockedOf(output: unknown): SubagentBlocked[] {
  if (!output || typeof output !== "object") return [];
  const o = output as Record<string, unknown>;
  /* `spawn_agent` 直接把 report 作为输出；某些宿主会包一层 `{ report }` —— 两种都认 */
  const report = (o.report ?? o) as Record<string, unknown>;
  const blocked = report?.blocked;
  if (!Array.isArray(blocked)) return [];
  return blocked.filter(
    (b): b is SubagentBlocked =>
      !!b && typeof b === "object" && typeof (b as SubagentBlocked).toolCallId === "string" && typeof (b as SubagentBlocked).name === "string",
  );
}

/**
 * 把父级留痕展开成"父级调用 + 子智能体待批行"。
 *
 * @param traces 投影出来的留痕（顺序：模型调用的顺序）
 * @returns 新的留痕数组（不改原数组）
 */
export function withSubagentApprovals(traces: readonly ToolTrace[]): ToolTrace[] {
  const seen = new Set(traces.map((t) => t.toolCallId));
  const out: ToolTrace[] = [];
  for (const trace of traces) {
    out.push(trace);
    if (trace.name !== SPAWN_AGENT_TOOL && trace.name !== SPAWN_AGENTS_TOOL) continue;
    /* 子智能体自己的待批行：已有同 id 的（例如父级也调了同名 id）不重复加 */
    const bubbles = blockedToTraces(blockedOf(trace.output)).filter((b) => !seen.has(b.toolCallId));
    for (const bubble of bubbles) {
      seen.add(bubble.toolCallId);
      out.push(bubble);
    }
  }
  return out;
}
