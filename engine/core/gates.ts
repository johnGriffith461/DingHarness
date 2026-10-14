import type { ApprovalRecord, TurnChunk } from "./events";

/**
 * **审批闸门的语义**（Phase 1 D5 尾部）。
 *
 * ## 它统一了什么
 *
 * 换代之前，"一次被拦下的调用"这件事的语义散在两处：
 *
 * | 问题 | 原来 | 现在 |
 * |---|---|---|
 * | 现在有哪些待办？ | `resumeSession` 里一段 for 循环自己挑 `trace.pending` | `pendingGates()` |
 * | 用户批了之后记什么？ | 宿主（`electron/ipc/ai.ts`）里**两个对象字面量**各拼一遍 | `approvalRecord()` |
 *
 * 第二个是真正的问题：批准与拒绝那两条分支**手抄了同一个形状**，
 * 抄漏一个字段（比如 `output`）不会报错 —— 只会表现为"重启后那条留痕变成一个没有内容的空壳"。
 * 收成一处之后，"决策记录长什么样"只有这个文件能改。
 *
 * ## ⚠️ 一处刻意的**不做**
 *
 * 方案里写过"pending 从消息上的一条 trace 升级为**独立的 gate 事件类型**"。
 * 这里**没有**新增事件类型，理由是可验证的：
 *
 * - 目的（重启后能还原待决列表、决策可审计、旧日志可读）**已经由现有记录形状满足** ——
 *   `tool-result` 里的 `{pending:true}` + `approval` 记录 + 回溯应用，
 *   三条合起来就是一份完整的"拦下 → 谁批的 → 结果"；
 * - 新增一个事件类型意味着**旧日志里没有它**，于是"读旧日志"的每条路径都要多一个分支 ——
 *   而它换来的可观测性增量是零（同样的信息已经在流里）。
 *
 * 所以这一层做的是**把语义收拢并命名**，不是改格式。哪天真需要"闸门本身"成为一个
 * 可查询的一等实体（比如按闸门统计人类响应时长），那时再引入事件类型，
 * 并把它当作一次**带迁移的格式变更**来做。
 */

/**
 * 一次「被拦下、还没处置」的调用。
 *
 * ⚠️ 带上 `input` 是因为放行时要**原样执行**那份参数（主进程不接受前端改过的参数）。
 * 参数丢了就只能重问用户一次 —— 那条路实测踩过
 * （`Cannot read properties of undefined (reading 'text')`）。
 */
export type GateRequest = {
  toolCallId: string;
  name: string;
  input?: unknown;
};

/**
 * 现在有哪些待办（按发生顺序）。
 *
 * ⚠️ 从**收尾后**的留痕里挑，而不是从原始事件流里挑：决策记录会**回溯**应用到它对应的
 * 那一轮（用户可能在那轮结束很久之后才点允许），所以"已经批过的那条"在留痕里
 * 已经不是 pending 了。从原始事件挑会挑出一堆"其实早就批过"的假待办 ——
 * 界面会给用户一个假的按钮，而他点了之后什么都不会发生。
 *
 * @param turns 按轮切好的会话（`splitTurns` 的输出）
 * @returns 待办清单
 */
export function pendingGates(turns: readonly TurnChunk[]): GateRequest[] {
  const out: GateRequest[] = [];
  for (const chunk of turns) {
    for (const trace of chunk.view.traces) {
      if (trace.pending !== true) continue;
      out.push({
        toolCallId: trace.toolCallId,
        name: trace.name,
        ...(trace.input === undefined ? {} : { input: trace.input }),
      });
    }
  }
  return out;
}

/** 一次决策的输入。 */
export type GateDecision = {
  toolCallId: string;
  /** 决策针对哪个工具（留痕要按名字找它）。 */
  name: string;
  approved: boolean;
  /**
   * 放行执行的结果。
   *
   * ⚠️ **批准时要把结果一起记进去**（拒绝时没有）：重放日志时要能还原成
   * "已保存，当前 N 条"那一行 —— 只记"批过了"的话，重启后那条留痕是个没有内容的空壳。
   */
  result?: { ok: boolean; output?: unknown; error?: string };
  /** 界面上那一行（主进程生成，与放行时返回给界面的**同一句**）。 */
  line: string;
};

/**
 * 把一次决策拼成**日志记录**（落盘形态由 store 补 `seq`/`at`）。
 *
 * @param decision 见 `GateDecision`
 * @returns 决策记录
 */
export function approvalRecord(decision: GateDecision): Omit<ApprovalRecord, "seq" | "at"> {
  const { result } = decision;
  return {
    type: "approval",
    toolCallId: decision.toolCallId,
    name: decision.name,
    approved: decision.approved,
    ...(decision.approved && result
      ? {
          ok: result.ok,
          ...(result.output === undefined ? {} : { output: result.output }),
          ...(result.error ? { error: result.error } : {}),
        }
      : {}),
    line: decision.line,
  };
}
