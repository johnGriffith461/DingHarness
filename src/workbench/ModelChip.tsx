import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Lock, Sparkles } from "lucide-react";

import { budgetOf } from "@engine/runtime/budget";
import { findModel } from "@engine/runtime/models";
import { listProviders } from "@/ai/aiClient";
import { readSavedRoute, resolveChatRoute } from "@/ai/route";

import { modelsForProvider } from "./ModelSettingsPage";

/**
 * 主页输入区的**模型选择器**（2026-10-16 第五版 —— ZCode 细则补齐）。
 *
 * 逐条对上 `docs/ZCODE-设置与模型选择-反解.md` 里那份规格：
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 *
 * | ZCode 的规矩 | 这里 |
 * |---|---|
 * | 多 provider → 一级 provider、悬停/聚焦展开二级模型 | ✅ |
 * | 单 provider → 一级直接列模型 | ✅ |
 * | 选中用 **radio 语义** | ✅ `role=menuitemradio` + `aria-checked` |
 * | **被当前运行任务限制的模型 → 禁用 + 锁定提示**，不触发切换 | ✅ `busy` 时禁用 + 「本轮正在跑」 |
 * | 非文本输入的模型 → 模型名后跟**「视觉」徽标** | ✅ 读目录表的 `capabilities.attachment` |
 * | 模型 ID 当**不透明字符串** | ✅ 原样显示与写入 |
 * | `Ctrl+M` 只唤起菜单、不循环切换 | ✅ 见 `Composer`（只 toggle 这一颗） |
 * | 模型切换 pending 时 spinner 放文案后面 | ⏳ 还没有 pending 态（切模型不发请求） |
 * | 「管理模型」入口归调用方 | ✅ 底部一行 → 设置 |
 */
export function ModelChip({
  open,
  onToggle,
  onClose,
  onOpenSettings,
  busy = false,
}: {
  open: boolean;
  onToggle: () => void;
  /** 关闭。**带 token**：只会关掉自己那次打开，不会误关已经接管的兄弟（见 Composer 的互斥实现）。 */
  onClose: () => void;
  onOpenSettings?: () => void;
  /** 这一轮是不是正在跑 —— 跑着的时候不许换模型（ZCode：禁用 + 锁定提示）。 */
  busy?: boolean;
}) {
  const [route, setRoute] = useState(() => readSavedRoute());
  const [providers, setProviders] = useState<
    Array<{ id: string; label: string; models: string[]; available: boolean; note?: string }>
  >([]);
  const [branch, setBranch] = useState("");
  /* C3：搜索（模型 id / provider 名，不区分大小写） */
  const [query, setQuery] = useState("");

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

  /*
   * P0-08：标签只说"用户钉住的那个"。没有钉住就写"自动选择"，
   * 不再把 localStorage 里残留的旧选择冒充成当前模型。
   * hover 里异步给出真正会被用的路由（拿不到就仍是"自动选择"）。
   */
  const label = route.provider && route.model ? `${route.provider}/${route.model}` : "自动选择";
  const [resolved, setResolved] = useState("");
  useEffect(() => {
    if (route.provider && route.model) return;
    let alive = true;
    void resolveChatRoute()
      .then((r) => {
        if (alive && r.provider && r.model) setResolved(`${r.provider}/${r.model}`);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [route.provider, route.model]);

  const pick = (provider: string, model: string): void => {
    if (busy) return;
    try {
      localStorage.setItem("dsh-canvas.chat-settings", JSON.stringify({ provider, model }));
    } catch {
      /* 存不进去也不影响这一次会话里已经生效的选择 */
    }
    setRoute({ provider, model });
    onClose();
  };

  /** 一条模型项：radio 语义 + 窗口/视觉徽标 + 无密钥置灰 + 锁（跑着的时候不许换）。 */
  const modelItem = (providerId: string, m: string, available = true) => {
    const on = route.provider === providerId && route.model === m;
    /* 目录表里声明的多模态输入（）—— 只描述登记的能力 */
    const vision = findModel(m)?.capabilities?.attachment === true;
    /* C3：窗口徽标（登记过才写；未登记不编数字） */
    const budget = budgetOf(m);
    const windowLabel = budget.registered
      ? budget.contextWindow >= 1_000_000
        ? `${Math.round(budget.contextWindow / 1_000_000)}M`
        : `${Math.round(budget.contextWindow / 1000)}k`
      : "";
    return (
      <button
        key={`${providerId}/${m}`}
        role="menuitemradio"
        aria-checked={on}
        aria-disabled={busy || !available || undefined}
        disabled={busy || !available}
        className={`wb-chip-option${on ? " is-on" : ""}`}
        data-testid={`wb-model-option-${providerId}-${m}`}
        title={
          busy
            ? "这一轮正在跑 —— 等它结束再换模型"
            : available
              ? m
              : `${providerId} 没有可用密钥 —— 去设置配置`
        }
        onClick={() => pick(providerId, m)}
      >
        <span className="wb-model-modelname">{m}</span>
        {windowLabel ? <em className="wb-model-flag" data-testid={`wb-model-window-${providerId}-${m}`}>{windowLabel}</em> : null}
        {/* 「视觉」= 目录表里声明的多模态输入（只描述 provider 登记的能力，不承诺适配器一定发得出附件） */}
        {vision ? (
          <em className="wb-model-flag" data-testid={`wb-model-vision-${providerId}-${m}`}>
            视觉
          </em>
        ) : null}
        {on ? <Check size={13} /> : null}
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
        title={
          busy
            ? "这一轮正在跑 —— 等它结束再换模型（Ctrl+M）"
            : route.provider && route.model
              ? `这一轮用哪个模型（当前钉住：${route.provider}/${route.model}）`
              : `自动选择（未钉住模型）${resolved ? `，将使用：${resolved}` : ""}`
        }
        onClick={onToggle}
      >
        <Sparkles size={13} /> {label} <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="wb-chip-pop wb-model-pop" data-testid="wb-model-pop" role="menu" onMouseLeave={onClose}>
          {busy ? (
            <div className="wb-model-note" data-testid="wb-model-locked">
              <Lock size={11} /> 这一轮正在跑 —— 跑完才能换模型
            </div>
          ) : null}
          {/* C3：搜索（20 个模型时敲 3 个字符就能命中） */}
          <input
            className="wb-model-search"
            data-testid="wb-model-search"
            placeholder="搜索模型（id 或 provider）…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {providers.length === 0 ? (
            <div className="wb-chip-empty" data-testid="wb-model-empty">
              还没有可用的 provider。去设置里配一条（地址 + 密钥，能把模型清单拉回来）。
            </div>
          ) : query.trim() ? (
            <div data-testid="wb-model-results">
              {(() => {
                const q = query.trim().toLowerCase();
                const hits = providers.flatMap((p) =>
                  p.models
                    .filter(
                      (m) =>
                        m.toLowerCase().includes(q) ||
                        p.label.toLowerCase().includes(q) ||
                        p.id.toLowerCase().includes(q),
                    )
                    .map((m) => ({ p, m })),
                );
                if (!hits.length) {
                  return (
                    <div className="wb-chip-empty" data-testid="wb-model-no-match">
                      没有匹配的模型
                    </div>
                  );
                }
                return hits.slice(0, 20).map(({ p, m }) => (
                  <div key={`${p.id}/${m}`}>
                    <div className="wb-model-match-provider">{p.label}</div>
                    {modelItem(p.id, m, p.available)}
                  </div>
                ));
              })()}
            </div>
          ) : single ? (
            <>
              <div className="wb-chip-title">{single.label}</div>
              {single.models.slice(0, 12).map((m) => modelItem(single.id, m, single.available))}
            </>
          ) : (
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
                    {(() => {
                      const provider = providers.find((p) => p.id === branch);
                      return (provider?.models ?? [])
                        .slice(0, 12)
                        .map((m) => modelItem(branch, m, provider?.available ?? true));
                    })()}
                  </div>
                ) : null}
              </div>
            </>
          )}
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
