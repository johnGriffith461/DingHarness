import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Sparkles } from "lucide-react";

import { listProviders } from "@/ai/aiClient";
import { readSavedRoute } from "@/ai/route";

import { modelsForProvider } from "./ModelSettingsPage";

/**
 * 主页输入区的**模型选择器**（2026-10-16 第四版 —— 照 ZCode 的模型菜单规格做）。
 *
 * ## 这一版改了什么（对照 `docs/ZCODE-设置与模型选择-反解.md`）
 *
 * | ZCode 的规矩 | 这里 |
 * |---|---|
 * | **多个 provider：一级是 provider、悬停展开二级是模型** | ✅ 二级菜单（`wb-model-provider-*` → `wb-model-option-*`） |
 * | **只有一个 provider：一级直接列模型**，不包一层 | ✅ 按 `providers.length === 1` 分流 |
 * | 选中用 **radio 语义** | ✅ `role="menuitemradio"` + `aria-checked` |
 * | 模型 ID 当**不透明字符串**（不许按 `/` 拆） | ✅ 原样显示与写入 |
 * | 「管理模型」入口由调用方控制 | ✅ 底部一行 → 开设置 |
 *
 * 主页**只选不配**（主人定的口径）：搜索与拉取都在设置页，这里不许有。
 * 清单优先读设置页勾过的那份（`modelsForProvider`），没动过设置时就是表里那份。
 */
export function ModelChip({
  open,
  onToggle,
  onClose,
  onOpenSettings,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onOpenSettings?: () => void;
}) {
  const [route, setRoute] = useState(() => readSavedRoute());
  const [providers, setProviders] = useState<
    Array<{ id: string; label: string; models: string[]; available: boolean; note?: string }>
  >([]);
  /** 二级菜单：当前展开的 provider（悬停或键盘进入时设）。 */
  const [branch, setBranch] = useState("");

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
            /* 设置页勾过的优先（没动过设置时 = 表里那份，行为与以前一样） */
            models: modelsForProvider(p.id, p.models).models,
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

  const label = route.provider && route.model ? `${route.provider}/${route.model}` : "默认通道";

  /** 选一条通道（模型 ID 原样写入 —— 它是**不透明字符串**，不按 `/` 拆）。 */
  const pick = (provider: string, model: string): void => {
    try {
      localStorage.setItem("dsh-canvas.chat-settings", JSON.stringify({ provider, model }));
    } catch {
      /* 存不进去也不影响这一次会话里已经生效的选择 */
    }
    setRoute({ provider, model });
    onClose();
  };

  /** 一条模型项（radio 语义 + 选中打勾）。 */
  const modelItem = (providerId: string, m: string) => {
    const on = route.provider === providerId && route.model === m;
    return (
      <button
        key={`${providerId}/${m}`}
        role="menuitemradio"
        aria-checked={on}
        className={`wb-chip-option${on ? " is-on" : ""}`}
        data-testid={`wb-model-option-${providerId}-${m}`}
        onClick={() => pick(providerId, m)}
      >
        {m} {on ? <Check size={13} /> : null}
      </button>
    );
  };

  const single = providers.length === 1 ? providers[0] : undefined;

  return (
    <div className="wb-chip-wrap">
      <button
        className="wb-chip"
        data-testid="wb-model"
        aria-label={`模型：${label}`}
        aria-haspopup="menu"
        title="这一轮用哪个模型（Ctrl+M；配 provider 与拉取模型在设置里）"
        onClick={onToggle}
      >
        <Sparkles size={13} /> {label} <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="wb-chip-pop wb-model-pop" data-testid="wb-model-pop" role="menu" onMouseLeave={onClose}>
          {providers.length === 0 ? (
            <div className="wb-chip-empty" data-testid="wb-model-empty">
              还没有可用的 provider。去设置里配一条（地址 + 密钥，能把模型清单拉回来）。
            </div>
          ) : single ? (
            /* 只有一家 → 一级直接列模型（ZCode：不额外包一层 provider） */
            <>
              <div className="wb-chip-title">{single.label}</div>
              {single.models.slice(0, 12).map((m) => modelItem(single.id, m))}
            </>
          ) : (
            /* 多家 → 一级 provider，悬停展开二级模型（ZCode 的形态） */
            <>
              <div className="wb-chip-title">模型</div>
              <div className="wb-model-branches">
                <div className="wb-model-rail">
                  {providers.map((p) => (
                    <button
                      key={p.id}
                      role="menuitem"
                      aria-haspopup="menu"
                      className={`wb-chip-option wb-model-branch${branch === p.id ? " is-on" : ""}`}
                      data-testid={`wb-model-provider-${p.id}`}
                      onMouseEnter={() => setBranch(p.id)}
                      onFocus={() => setBranch(p.id)}
                      onClick={() => setBranch(p.id)}
                    >
                      <span className="wb-model-group-name">
                        {p.label}
                        {p.available ? null : <em className="wb-chip-badge">无密钥</em>}
                      </span>
                      <ChevronRight size={12} />
                    </button>
                  ))}
                </div>
                {branch ? (
                  <div className="wb-model-leaf" data-testid="wb-model-leaf">
                    {(providers.find((p) => p.id === branch)?.models ?? []).slice(0, 12).map((m) => modelItem(branch, m))}
                  </div>
                ) : null}
              </div>
            </>
          )}
          {/* 「管理模型」→ 设置 →「模型」（ZCode：入口由调用方控制） */}
          {onOpenSettings ? (
            <button
              className="wb-chip-option wb-model-manage"
              data-testid="wb-model-manage"
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
            >
              管理模型（设置 →「模型」）
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
