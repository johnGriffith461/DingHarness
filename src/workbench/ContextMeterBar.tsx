import { useEffect, useState } from "react";

import { useWorkbenchStore } from "./store";
import { parseBudgetMode } from "@engine/runtime/budget";
import { totalTokens } from "@engine/core/context";
import { contextMeterOf, formatMeter, formatWindowLimit } from "./contextMeter";
import { pinnedModelNow, useAppSettings } from "./appSettings";

/**
 * 输入区右侧的上下文压力（C2）。
 *
 * ## 两条口径（T-07 补第二条）
 *
 * 1. **任务页**：分母 = 这一轮实际用的模型的保留额度；分子优先 provider 实测 usage。
 * 2. **首页**：**不显示上一段会话的用量** —— 那是"刚才那段"的数，不是当前要发的这段。
 *    首页只说"模型窗口 N token 可用"（按钉住/声明的模型推导）。
 *
 * T-07 之前首页会回显上一段任务的 44.2k / 20k（221% 红条），
 * 用户以为新对话一开始就满了（WorkBuddy 截图）。
 */

function budgetModeNow() {
  try {
    return parseBudgetMode(localStorage.getItem("dsh-canvas.context-budget"));
  } catch {
    return parseBudgetMode(undefined);
  }
}

/** 用户声明模型的保留额度（`models.json` 的 exact 规则算好的 `keepTokens`）。 */
function useDeclaredKeepTokens(): Record<string, number> {
  const [byModel, setByModel] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    const bridge = (globalThis as unknown as {
      shell?: { modelConfig?: { list?: (mode?: string) => Promise<{ models?: Array<{ modelId: string; keepTokens: number }> }> } };
    }).shell;
    void Promise.resolve(bridge?.modelConfig?.list?.(localStorage.getItem("dsh-canvas.context-budget") ?? undefined))
      .then((got) => {
        if (!alive || !got?.models) return;
        const map: Record<string, number> = {};
        for (const m of got.models) if (m.keepTokens > 0) map[m.modelId] = m.keepTokens;
        setByModel(map);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return byModel;
}

export function ContextMeterBar() {
  const view = useWorkbenchStore((s) => s.view);
  const task = useWorkbenchStore((s) => s.tasks.find((t) => t.id === s.activeTaskId));
  const pinned = useAppSettings((s) => s.pinnedModel) || pinnedModelNow();
  const pinnedModel = pinned.includes("/") ? pinned.slice(pinned.indexOf("/") + 1) : "";
  /*
   * 任务页优先这一段**实际用过**的模型；首页只看钉住的那个 ——
   * 首页不该被"上一段任务用了什么"污染。
   */
  const modelId = (view === "home" ? pinnedModel : task?.lastRoute?.model ?? pinnedModel) || undefined;
  const declaredKeep = useDeclaredKeepTokens();

  /* 最近一次 provider 用量（只在任务页读） */
  const usage = view === "home"
    ? undefined
    : [...(task?.steps ?? [])].reverse().find((s) => s.role === "assistant" && s.usage)?.usage;
  const messages = view === "home"
    ? []
    : (task?.steps ?? []).map((s) => ({ role: s.role, content: s.text }));
  const meter = contextMeterOf({
    modelId,
    mode: budgetModeNow(),
    ...(usage ? { usage } : {}),
    estimatedTokens: totalTokens(messages),
    ...(modelId && declaredKeep[modelId] ? { declaredKeepTokens: declaredKeep[modelId] } : {}),
  });

  const tone = meter.status === "full" ? "全" : meter.status === "warn" ? "黄" : "正常";
  if (!modelId) {
    return (
      <span
        className="wb-context-meter"
        data-testid="wb-context-meter"
        data-status="unknown"
        title="还没有选模型（自动选择）—— 在设置里选一个，或直接发一句让它自动挑"
      >
        未选择模型
      </span>
    );
  }
  /*
   * 首页：只说窗口有多大，**不带上一段的用量**。
   * 文案里明确"可用"，不写百分比 —— 新对话还没开始用。
   */
  if (view === "home") {
    const windowText = meter.unknownWindow ? "窗口未知" : `模型窗口 ${formatWindowLimit(meter.limit)} token 可用`;
    return (
      <span
        className="wb-context-meter"
        data-testid="wb-context-meter"
        data-status="home"
        title={`新对话还没开始：这里显示的是「${modelId}」的可用上下文额度（不含上一段会话的用量）`}
      >
        {windowText}
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
