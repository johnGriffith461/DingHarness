import { useState } from "react";
import { Check, ClipboardList, Loader2, X } from "lucide-react";

import { missingPlanSections, PLAN_TEXT_LIMIT } from "@engine/runtime/planMode";
import { useWorkbenchStore } from "./store";
import type { WorkTask } from "./task";

/**
 * 计划面板（G1）。
 *
 * 只在任务真的进入计划状态时挂载：`planning` 显示探索中，`awaiting_approval`
 * 允许编辑并批准，`executing` 折叠成一行。面板本身**不写盘** ——
 * 写盘只发生在「开始执行」那一刻（`store.approvePlan`），这样用户改了多少次
 * 都不会在磁盘上留下半成品。
 */
export function PlanPanel({ task }: { task: WorkTask }) {
  const setPlanText = useWorkbenchStore((s) => s.setPlanText);
  const approvePlan = useWorkbenchStore((s) => s.approvePlan);
  const abandonPlan = useWorkbenchStore((s) => s.abandonPlan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const state = task.planState ?? "idle";
  if (state === "idle") return null;

  if (state === "executing") {
    return (
      <aside className="wb-plan-panel is-collapsed" data-testid="wb-plan-panel" data-plan-state="executing">
        <div className="wb-plan-collapsed">
          <Check size={14} /> 计划已批准
          {task.planPath ? (
            <span className="wb-plan-path" title={task.planPath}>
              {task.planPath}
            </span>
          ) : null}
        </div>
        {task.planWriteError ? (
          <div className="wb-plan-error" data-testid="wb-plan-write-error">
            未落盘（{task.planWriteError}）—— 仍按面板内容执行
          </div>
        ) : null}
      </aside>
    );
  }

  const text = task.planText ?? "";
  const missing = missingPlanSections(text);
  const tooLong = text.length >= PLAN_TEXT_LIMIT;
  const canApprove = state === "awaiting_approval" && text.trim().length > 0 && missing.length === 0;

  return (
    <aside className="wb-plan-panel" data-testid="wb-plan-panel" data-plan-state={state}>
      <header className="wb-plan-head">
        <ClipboardList size={15} />
        <b>{state === "planning" ? "计划：正在探索" : "计划：等待批准"}</b>
      </header>
      <div className="wb-plan-hint">
        {state === "planning"
          ? "模型正在只读探索；给出计划后可以在这里修改。"
          : "确认后写入 .ding/plans/ 并开始执行。改成你要的样子再批准。"}
      </div>
      <textarea
        className="wb-plan-input"
        data-testid="wb-plan-input"
        aria-label="计划内容"
        value={text}
        placeholder={state === "planning" ? "计划正在生成…" : "计划内容"}
        onChange={(e) => setPlanText(task.id, e.target.value)}
        spellCheck={false}
      />
      {tooLong ? (
        <div className="wb-plan-note">超过 20 KiB，超出部分会在落盘时截断。</div>
      ) : null}
      {state === "awaiting_approval" && missing.length > 0 ? (
        <div className="wb-plan-note" data-testid="wb-plan-missing">
          计划不完整：缺 {missing.join("、")}。补全后才能开始执行。
        </div>
      ) : null}
      {error ? (
        <div className="wb-plan-error" data-testid="wb-plan-error">
          {error}
        </div>
      ) : null}
      <div className="wb-plan-actions">
        <button
          className="wb-chip wb-plan-btn"
          data-testid="wb-plan-approve"
          disabled={!canApprove || busy}
          title={canApprove ? "写入计划文件并开始执行" : missing.length ? `缺：${missing.join("、")}` : "先让模型给出计划"}
          onClick={() => {
            setBusy(true);
            setError("");
            void approvePlan(task.id)
              .then((got) => {
                if (!got.ok) setError(got.error ?? "批准失败");
                else if (got.error) setError(`已开始执行，但未落盘：${got.error}`);
              })
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Loader2 size={13} /> : <Check size={13} />} 开始执行
        </button>
        <button
          className="wb-chip wb-plan-btn"
          data-testid="wb-plan-abandon"
          disabled={busy}
          onClick={() => {
            setError("");
            abandonPlan(task.id);
          }}
        >
          <X size={13} /> 放弃
        </button>
      </div>
    </aside>
  );
}
