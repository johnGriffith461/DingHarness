import { Check, ChevronDown, Gauge } from "lucide-react";

import { EFFORT_LABEL, REASONING_EFFORTS, type ReasoningEffort } from "@engine/runtime/protocols/reasoning";

import { useEffortStore } from "./effortStore";

/**
 * **思考强度**这颗控件（2026-10-16）—— 与模型选择器**分开**的两颗（主人的口径：
 * 「另一个按钮 它可以选择思考强度」）。
 *
 * 与画布对话那处**同一份状态**（`effortStore`），所以两处永远一个值；
 * 而与主页的模型选择器分开，是因为它俩是两件事：
 *   模型 = **用谁的脑子**；思考强度 = **让它想多深**。
 *
 * ⚠️ 「默认」= **一个字段都不发**（各家自己的档），不是某一档 —— 文案上写清楚。
 */
export function EffortChip({
  open,
  onToggle,
  onClose,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const effort = useEffortStore((s) => s.effort);
  const setEffort = useEffortStore((s) => s.setEffort);
  const label = effort ? `思考${EFFORT_LABEL[effort]}` : "思考默认";

  const pick = (next: ReasoningEffort | undefined): void => {
    setEffort(next);
    onClose();
  };

  return (
    <div className="wb-chip-wrap wb-chip-effort">
      <button
        className="wb-chip"
        data-testid="wb-effort"
        aria-label={`思考强度：${label}`}
        title="让它想多深（默认 = 各家自己的档）"
        onClick={onToggle}
      >
        <Gauge size={13} /> {label} <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="wb-chip-pop" data-testid="wb-effort-pop" onMouseLeave={onClose}>
          <button
            className={`wb-chip-option${effort === undefined ? " is-on" : ""}`}
            data-testid="wb-effort-auto"
            onClick={() => pick(undefined)}
          >
            {/* 2026-10-22 主人：首项只留「默认」，括号里的解释去掉 */}
            默认{effort === undefined ? <Check size={13} /> : null}
          </button>
          {REASONING_EFFORTS.map((e) => (
            <button
              key={e}
              className={`wb-chip-option${effort === e ? " is-on" : ""}`}
              data-testid={`wb-effort-${e}`}
              onClick={() => pick(e)}
            >
              思考{EFFORT_LABEL[e]}
              {effort === e ? <Check size={13} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
