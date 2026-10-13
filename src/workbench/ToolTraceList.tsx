import type { ToolTrace } from "@shared/agentTools";

/**
 * 工具留痕列表（§185 抽出来的共享组件）。
 *
 * ## 为什么抽出来
 *
 * 这段标记原来只长在工作台的步骤里。而**聊天那条路上是一模一样的需要**：
 * 被闸门拦下的调用写着「等你确认」，却**没有可点的按钮** —— 那是一条
 * **无法处置的通知**（§176 已经为"子智能体上交的调用"修过同款问题）。
 *
 * 抽成一个组件之后：**一处实现、两个界面**。
 * 而且聊天的验证可以直接搭在工作台那条验收上（§176 的 `accept-approve.mjs`
 * 就是这条组件的回归哨兵）。
 */
export function ToolTraceList({
  traces,
  onResolve,
  testIdPrefix = "wb-tools",
  /**
   * 每个 action 的 testid 前缀。
   *
   * 两个界面各用各的（工作台 `wb-tool-allow-*`、聊天 `chat-tool-allow-*`），
   * 免得自动化脚本在两边撞车。
   */
  actionPrefix = "wb-tool",
  /** 列表容器的 testid（配上这一步/这条消息的 id）。 */
  id,
}: {
  traces: ToolTrace[];
  onResolve: (toolCallId: string, approve: boolean) => void;
  testIdPrefix?: string;
  actionPrefix?: string;
  id: string;
}) {
  if (traces.length === 0) return null;

  return (
    <div className="wb-assistant-tools" data-testid={`${testIdPrefix}-${id}`}>
      {traces.map((t, i) => (
        /*
          被审批闸门拦下（`pending`）的那一条要**给出路**（§144）：
          「允许」= 原样执行「拒绝」= 只留痕。没有这两个按钮，
          闸门就只是"拦下并让你干等着" —— 那是半步。
        */
        <span
          className={`wb-tool-line${t.ok ? "" : " is-bad"}`}
          key={t.toolCallId || `${t.name}-${i}`}
          /*
           * 稳定 testid（§176）：不能靠里面的按钮定位这一行 ——
           * 放行/拒绝之后**按钮就没了**，那样"读那一行的文案"会在操作之后失效。
           */
          data-testid={t.toolCallId ? `wb-tool-line-${t.toolCallId}` : undefined}
        >
          {t.line}
          {t.pending ? (
            <span className="wb-tool-actions">
              <button
                className="wb-tool-btn is-primary"
                data-testid={`${actionPrefix}-allow-${t.toolCallId}`}
                onClick={() => onResolve(t.toolCallId, true)}
              >
                允许
              </button>
              <button
                className="wb-tool-btn"
                data-testid={`${actionPrefix}-deny-${t.toolCallId}`}
                onClick={() => onResolve(t.toolCallId, false)}
              >
                拒绝
              </button>
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}
