import { useEffect, useState } from "react";
import { Check, ChevronDown, Sparkles } from "lucide-react";

import { listProviders } from "@/ai/aiClient";
import { readSavedRoute } from "@/ai/route";


/**
 * 主页输入区的**模型选择器**（2026-10-16，第三版 —— 主人的口径）。
 *
 * ## 它只做一件事：**选**（主人的原话）
 *
 * 「用户配置模型 他应该在设置页面里边去配置好这个模型 然后在主页的这个选择器里边
 *   点击这个选择器 能够选择模型」
 *
 * 所以这里**没有**搜索框、**没有**拉取按钮、**没有**思考强度 —— 那些都不属于"选"：
 * · 「拉取模型」是**配置**，归设置页（设置 → 模型）；
 * · 「思考强度」是**另一颗控件**（`EffortChip`，就挂在这颗旁边）。
 *
 * 第二版我把搜 / 拉 / 档位三件事全塞进这一个弹层里 —— 主人说得对，那是垃圾设计。
 *
 * 列表按 provider 分组（一屏能扫完），点一条就写进 `dsh-canvas.chat-settings` ——
 * 与 `resolveChatRoute` 读的是**同一个键**，所以选完下一句真按它发。
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

  /* chip 上写"哪家 / 哪个模型"；还没选过就如实写"默认通道"（路由会自己挑一条） */
  const label = route.provider && route.model ? `${route.provider}/${route.model}` : "默认通道";

  /** 选一条通道。 */
  const pick = (provider: string, model: string): void => {
    try {
      localStorage.setItem("dsh-canvas.chat-settings", JSON.stringify({ provider, model }));
    } catch {
      /* 存不进去也不影响这一次会话里已经生效的选择 */
    }
    setRoute({ provider, model });
    onClose();
  };

  return (
    <div className="wb-chip-wrap">
      <button
        className="wb-chip"
        data-testid="wb-model"
        aria-label={`模型：${label}`}
        title="这一轮用哪个模型（在设置里配置 provider 与密钥）"
        onClick={onToggle}
      >
        <Sparkles size={13} /> {label} <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="wb-chip-pop wb-model-pop" data-testid="wb-model-pop" onMouseLeave={onClose}>
          {providers.length === 0 ? (
            <div className="wb-chip-empty" data-testid="wb-model-empty">
              还没有可用的 provider。去设置里配一条（地址 + 密钥，能把模型清单拉回来）。
            </div>
          ) : (
            providers.map((p) => (
              <div key={p.id}>
                <div className="wb-chip-row" title={p.note ?? ""}>
                  <span className="wb-model-group-name">
                    {p.label}
                    {p.available ? null : <em className="wb-chip-badge">无密钥</em>}
                  </span>
                </div>
                {p.models.slice(0, 8).map((m) => {
                  const on = route.provider === p.id && route.model === m;
                  return (
                    <button
                      key={m}
                      className={`wb-chip-option${on ? " is-on" : ""}`}
                      data-testid={`wb-model-option-${p.id}-${m}`}
                      onClick={() => pick(p.id, m)}
                    >
                      {m} {on ? <Check size={13} /> : null}
                    </button>
                  );
                })}
                {p.models.length > 8 ? (
                  <div className="wb-model-note">还有 {p.models.length - 8} 个（在设置里看全）</div>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
