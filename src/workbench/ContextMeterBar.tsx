import { useWorkbenchStore } from "./store";
import { readSavedRoute } from "@/ai/route";
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
  const route = readSavedRoute();

  /* 最近一次 provider 用量（往前找第一条带 usage 的助手步骤） */
  const usage = [...(task?.steps ?? [])]
    .reverse()
    .find((s) => s.role === "assistant" && s.usage)?.usage;
  const messages = (task?.steps ?? []).map((s) => ({ role: s.role, content: s.text })) as Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  const meter = contextMeterOf({
    modelId: route.model,
    mode: budgetModeNow(),
    ...(usage ? { usage } : {}),
    estimatedTokens: totalTokens(messages),
  });

  const tone = meter.status === "full" ? "全" : meter.status === "warn" ? "黄" : "正常";
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
