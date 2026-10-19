import { useWorkbenchStore } from "./store";
import { parseBudgetMode } from "@engine/runtime/budget";
import { totalTokens } from "@engine/core/context";
import { contextMeterOf, formatMeter } from "./contextMeter";

/**
 * 输入区右侧的上下文压力（C2）。
 *
 * 分母来自 `keepTokensFor`（模型登记过就是它的窗口推导值；没登记就 20k 并标"窗口未知"）；
 * 分子优先用 provider 回来的 usage，没有才用字数估算 —— 两种来源在界面上分开标。
 */

function budgetModeNow() {
  try {
    return parseBudgetMode(localStorage.getItem("dsh-canvas.context-budget"));
  } catch {
    return parseBudgetMode(undefined);
  }
}

export function ContextMeterBar() {
  const task = useWorkbenchStore((s) => s.tasks.find((t) => t.id === s.activeTaskId));
  /*
   * P0-08：分母只认**这一段任务实际用过的模型**（`lastRoute`）。
   * 没有记录时不再拿 localStorage 里那个可能过期的 route 假装成模型上限 ——
   * 直接说"自动选择（未记录）"，而不是显示一个 20k 的假分母。
   */
  const modelId = task?.lastRoute?.model;

  /* 最近一次 provider 用量（往前找第一条带 usage 的助手步骤） */
  const usage = [...(task?.steps ?? [])]
    .reverse()
    .find((s) => s.role === "assistant" && s.usage)?.usage;
  const messages = (task?.steps ?? []).map((s) => ({ role: s.role, content: s.text })) as Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  const meter = contextMeterOf({
    modelId,
    mode: budgetModeNow(),
    ...(usage ? { usage } : {}),
    estimatedTokens: totalTokens(messages),
  });

  const tone = meter.status === "full" ? "全" : meter.status === "warn" ? "黄" : "正常";
  if (!modelId) {
    return (
      <span
        className="wb-context-meter"
        data-testid="wb-context-meter"
        data-status="unknown"
        title="还没有记录这一段任务实际使用的模型（自动选择）—— 跑一轮之后这里会显示真实窗口与用量"
      >
        自动选择（未记录）
      </span>
    );
  }
  return (
    <span
      className={`wb-context-meter is-${meter.status}`}
      data-testid="wb-context-meter"
      data-status={meter.status}
      title={`上下文压力 ${tone}：${formatMeter(meter)}（来源：${meter.source === "provider" ? "provider 实测" : "按字数估算"}）`}
    >
      {formatMeter(meter)}
      <em data-testid="wb-context-source">{meter.source === "provider" ? "实测" : "估算"}</em>
    </span>
  );
}
