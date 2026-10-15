import { useEffect, useState } from "react";
import { Check, ChevronDown, Sparkles } from "lucide-react";

import { EFFORT_LABEL, REASONING_EFFORTS, type ReasoningEffort } from "@engine/runtime/protocols/reasoning";
import { listProviders } from "@/ai/aiClient";
import { readSavedRoute } from "@/ai/route";

import { readReasoningEffort, saveReasoningEffort } from "./reasoningEffort";

/**
 * 输入区的「模型 · 思考」chip（2026-10-16）。
 *
 * 主人的话：「这是个假按钮吧，没法选择模型、也没法选择思考强度，这按钮是必须的呀。」
 * 之前那颗写死显示 `AUTO · LOW` 的假档位键在 M0 就被拿掉了（它显示的不是任何真实状态），
 * 这一颗是**真的**：
 *
 * · **模型**：列本机所有 provider 的模型（没密钥的也列出来，但标「无密钥」）。
 *   选中后写进 `dsh-canvas.chat-settings` —— 与 `resolveChatRoute` 读的是**同一个键**，
 *   所以选完下一句就真按它发（**没有第二份状态要同步**，那正是这类"选择器"最容易烂的地方）。
 * · **思考强度**：默认 / 低 / 中 / 高。默认 = **一个字段都不发**（各家自己的默认），
 *   选了才发；三家协议怎么写见 `engine/runtime/protocols/reasoning.ts`。
 *
 * ⚠️ 还没选过通道时 chip 写「默认通道」而**不是**「选模型」：这时候并不是没模型可用 ——
 * `resolveChatRoute` 会按「新对话默认模型」或第一条可用通道自动挑。写成「选模型」会让人
 * 以为现在是坏的。
 */
export function ModelChip({
  open,
  onToggle,
  onClose,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const [route, setRoute] = useState(() => readSavedRoute());
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(() => readReasoningEffort());
  /** 可选的 provider/模型。**菜单打开时才拉**（它是主进程的状态，没必要一直挂着）。 */
  const [providers, setProviders] = useState<
    Array<{ id: string; label: string; models: string[]; available: boolean; note?: string }>
  >([]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void listProviders()
      .then((list) => {
        if (!alive) return;
        setProviders(
          list.map((p) => ({
            id: p.id,
            label: p.label,
            models: p.models,
            available: p.available,
            ...(p.note ? { note: p.note } : {}),
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open]);

  const effortLabel = effort ? `思考${EFFORT_LABEL[effort]}` : "默认";
  const label = route.model ? `${route.model} · ${effortLabel}` : `默认通道 · ${effortLabel}`;

  /** 选一条通道。 */
  const pickModel = (provider: string, model: string): void => {
    try {
      localStorage.setItem("dsh-canvas.chat-settings", JSON.stringify({ provider, model }));
    } catch {
      /* 存不进去也不影响这一次会话里已经生效的选择 */
    }
    setRoute({ provider, model });
    onClose();
  };

  /** 选思考强度（`undefined` = 默认 = 一个字段都不发）。 */
  const pickEffort = (next: ReasoningEffort | undefined): void => {
    saveReasoningEffort(next);
    setEffort(next);
    onClose();
  };

  return (
    <div className="wb-chip-wrap">
      <button
        className="wb-chip"
        data-testid="wb-model"
        aria-label={`模型与思考强度：${label}`}
        title="这一轮用哪个模型、让它想多深"
        onClick={onToggle}
      >
        <Sparkles size={13} /> {label} <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="wb-chip-pop wb-model-pop" data-testid="wb-model-pop" onMouseLeave={onClose}>
          <div className="wb-chip-title">模型</div>
          {providers.length === 0 ? (
            <div className="wb-chip-empty" data-testid="wb-model-empty">
              还没有可用的 provider。先在设置里配一条密钥。
            </div>
          ) : (
            providers.map((p) => (
              <div key={p.id}>
                <div className="wb-chip-row" title={p.note ?? ""}>
                  {p.label}
                  {p.available ? null : <em className="wb-chip-badge">无密钥</em>}
                </div>
                {p.models.slice(0, 6).map((m) => {
                  const on = route.provider === p.id && route.model === m;
                  return (
                    <button
                      key={m}
                      className={`wb-chip-option${on ? " is-on" : ""}`}
                      data-testid={`wb-model-option-${p.id}-${m}`}
                      onClick={() => pickModel(p.id, m)}
                    >
                      {m} {on ? <Check size={13} /> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
          <div className="wb-chip-title">思考强度</div>
          <button
            className={`wb-chip-option${effort === undefined ? " is-on" : ""}`}
            data-testid="wb-effort-auto"
            onClick={() => pickEffort(undefined)}
          >
            默认（各家自己的档）{effort === undefined ? <Check size={13} /> : null}
          </button>
          {REASONING_EFFORTS.map((e) => (
            <button
              key={e}
              className={`wb-chip-option${effort === e ? " is-on" : ""}`}
              data-testid={`wb-effort-${e}`}
              onClick={() => pickEffort(e)}
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
