import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, RefreshCw, Search, Sparkles } from "lucide-react";

import { EFFORT_LABEL, REASONING_EFFORTS, type ReasoningEffort } from "@engine/runtime/protocols/reasoning";
import { listProviders } from "@/ai/aiClient";
import { readSavedRoute } from "@/ai/route";
import type { ShellBridge } from "@shared/ipc";

import { useEffortStore } from "./effortStore";

/**
 * 输入区的「模型 · 思考」选择器（2026-10-16，第二版）。
 *
 * ## 这一版照谁做的（主人给的那串参考项目）
 *
 * 那些项目的模型切换器有四个共性，这里逐条对上：
 *
 * | 共性 | 在这里的落点 |
 * |---|---|
 * | **当前选择一行说清**（`provider / model`），不是只写字面 | chip 上就是 `provider/model · 思考X` |
 * | **列表按 provider 分组**，一屏能扫完 | 每组一行组名（带"有无密钥"），下面是它的模型 |
 * | **能搜**（模型一多就靠它） | 顶上那颗搜索框按子串过滤（匹配 provider 名或模型名） |
 * | **能就地拉取真实清单**（用户自己填的 API 尤其需要） | 每组右侧一颗「⟳ 拉取」→ `ai.fetchModels` |
 *
 * 另外两条我们自己的口径：
 * · **思考强度**与画布那处**同一份状态**（`effortStore`），两处永远一个值；
 * · **拉回来的清单只活在这一次会话里**（不落盘）—— 它是"对方此刻有什么"，不是我的配置。
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
  const effort = useEffortStore((s) => s.effort);
  const setEffort = useEffortStore((s) => s.setEffort);
  /** 可选的 provider/模型。**菜单打开时才拉**（它是主进程的状态，没必要一直挂着）。 */
  const [providers, setProviders] = useState<
    Array<{ id: string; label: string; models: string[]; available: boolean; note?: string }>
  >([]);
  /** 「⟳ 拉取」拉回来的真实清单（按 provider 存）。 */
  const [fetched, setFetched] = useState<Record<string, string[]>>({});
  /** 正在拉 / 拉失败了那句话。 */
  const [pulling, setPulling] = useState<{ id: string; note: string } | null>(null);
  /** 搜索框（模型一多就靠它）。 */
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPulling(null);
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
  const label = route.model ? `${route.provider}/${route.model} · ${effortLabel}` : `默认通道 · ${effortLabel}`;

  /**
   * 拉这一家真实的模型清单。
   *
   * 名字对不对**不靠猜**：名单由对方给（解析口径见 `engine/runtime/modelsFetch.ts`）。
   * 拿不到就把原因写在那一行下面 —— 静默失败比报错更坏。
   */
  const pullModels = (id: string): void => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    if (!shell?.ai?.fetchModels) {
      setPulling({ id, note: "拉取要在本应用里用（浏览器预览没有 IPC）" });
      return;
    }
    setPulling({ id, note: "拉取中…" });
    void shell.ai
      .fetchModels({ providerId: id })
      .then((got) => {
        if (got.ok && got.models?.length) {
          setFetched((prev) => ({ ...prev, [id]: got.models! }));
          setPulling(null);
        } else {
          setPulling({ id, note: got.error ?? "没拉到" });
        }
      })
      .catch((e) => setPulling({ id, note: String(e).slice(0, 80) }));
  };

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
    setEffort(next);
    onClose();
  };

  /** 搜索：匹配 provider 名或模型名（拉回来的也算）；空搜索 = 全部。 */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers
      .map((p) => {
        const models = fetched[p.id] ?? p.models;
        const hitProvider = !q || p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
        const shown = hitProvider ? models : models.filter((m) => m.toLowerCase().includes(q));
        return { ...p, models: shown };
      })
      .filter((p) => p.models.length > 0);
  }, [providers, fetched, query]);

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
          {/* 搜索（参考项目的共性之一：模型一多就得能搜） */}
          <label className="wb-model-search">
            <Search size={12} />
            <input
              data-testid="wb-model-search"
              placeholder="搜模型或 provider"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          <div className="wb-chip-title">模型</div>
          {groups.length === 0 ? (
            <div className="wb-chip-empty" data-testid="wb-model-empty">
              {providers.length === 0 ? "还没有可用的 provider。先在设置里配一条密钥。" : `没有匹配「${query}」的模型`}
            </div>
          ) : (
            groups.map((p) => (
              <div key={p.id}>
                <div className="wb-chip-row" title={p.note ?? ""}>
                  <span className="wb-model-group-name">
                    {p.label}
                    {p.available ? null : <em className="wb-chip-badge">无密钥</em>}
                  </span>
                  {/* 就地拉取真实清单（用户自己填的 API 尤其需要） */}
                  <button
                    className="wb-model-pull"
                    data-testid={`wb-model-pull-${p.id}`}
                    title={`拉取 ${p.label} 真实的模型清单（GET {baseURL}/models）`}
                    onClick={() => pullModels(p.id)}
                  >
                    <RefreshCw size={11} /> 拉取
                  </button>
                </div>
                {pulling?.id === p.id ? <div className="wb-model-note">{pulling.note}</div> : null}
                {p.models.slice(0, 40).map((m) => {
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
