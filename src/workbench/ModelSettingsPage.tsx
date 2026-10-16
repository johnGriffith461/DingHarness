import { useEffect, useState } from "react";
import { Check, RefreshCw } from "lucide-react";

import { listProviders } from "@/ai/aiClient";
import { readSavedRoute } from "@/ai/route";
import type { ShellBridge } from "@shared/ipc";

/**
 * 设置 →「模型」子页（2026-10-16，主人：「我要的是一个完整的设计页，参考我之前给你那些开源项目」）。
 *
 * ## 布局照谁做的
 *
 * OpenCode / Goose / Cline / OpenHands / anything-llm 那一类项目的 provider 设置页都是同一个套路：
 *
 * ```
 * ┌ provider 列表（标"有无密钥 / 验没验过"）┬ 这一家的详情 ─────────────┐
 * │ DeepSeek 官方           有密钥          │ 地址：…（表里来的，只读）  │
 * │ tokenrhythm 中转        有密钥          │ [⟳ 拉取模型]               │
 * │ apiKeyFan 中转          无密钥          │ ☑ deepseek-flash ★默认     │
 * │ …                                      │ ☐ deepseek-v4-pro          │
 * └────────────────────────────────────────┴────────────────────────────┘
 * ```
 *
 * 「拉取模型」是这一页的**核心动作**：名字由对方给，不由我们猜（口径见 `engine/runtime/modelsFetch.ts`）。
 * 勾选 = 这家的哪些模型要出现在**主页那颗选择器**里；★ = 默认模型。
 *
 * ## 存哪儿（以及为什么不用 IPC）
 *
 * 存在 `localStorage`（`dsh-canvas.model-settings`）——因为**只有渲染侧需要它**：
 * 主页那颗选择器同在一个渲染进程里；而请求该用哪家/哪个模型走的是另一条既有通道
 * （`dsh-canvas.chat-settings`，主进程只认那一条）。所以这里不新增 IPC，也不落主进程。
 * ⚠️ 密钥**不在这一页存**（那一层归 `safeStorage`，见 SAFETY.md）——这一页只管"有哪些模型、用哪几个"。
 */

const KEY = "dsh-canvas.model-settings";

/** 一家 provider 的本地配置。 */
export type ProviderModels = {
  /** 拉回来的真实清单（拉过才有；没拉过就空着）。 */
  models?: string[];
  /** 勾选要出现在主页选择器里的模型（空/缺省 = 用表里的默认清单）。 */
  enabled?: string[];
  /** 默认模型（点★设的那一个）。 */
  default?: string;
};

type Store = Record<string, ProviderModels>;

/** 读全部（读不动就空 —— 这一页读坏了不该让设置打不开）。 */
export function readModelSettings(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/** 写一家。 */
export function saveProviderModels(providerId: string, value: ProviderModels): void {
  try {
    const all = readModelSettings();
    all[providerId] = value;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 存不进去也不影响这一次会话里已经生效的选择 */
  }
}

/**
 * 主页选择器该显示这一家的哪些模型。
 *
 * 顺序：**勾选过的** > 拉回来但没勾的 > 表里写死的（兜底）。
 * 也就是说：用户没动过这一页时，行为与以前**一模一样**。
 */
export function modelsForProvider(
  providerId: string,
  fromTable: readonly string[],
): { models: string[]; defaultModel?: string } {
  const got = readModelSettings()[providerId];
  if (!got) return { models: [...fromTable] };
  const models = got.enabled?.length ? got.enabled : (got.models ?? [...fromTable]);
  return { models, ...(got.default ? { defaultModel: got.default } : {}) };
}

export function ModelSettingsPage() {
  const [providers, setProviders] = useState<
    Array<{ id: string; label: string; models: string[]; available: boolean; verified?: boolean; note?: string; keyRef?: string }>
  >([]);
  const [active, setActive] = useState("");
  const [pulling, setPulling] = useState<{ id: string; note: string } | null>(null);
  const [store, setStore] = useState<Store>(() => readModelSettings());
  /** 正在输入的密钥（**保存后立刻清空**：值不留在前端）。 */
  const [keyDraft, setKeyDraft] = useState("");
  /** 保存结果（成功 / 失败原因，原样来自主进程）。 */
  const [keyNote, setKeyNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void listProviders()
      .then((list) => {
        if (!alive) return;
        setProviders(list.map((p) => ({ ...p })));
        setActive((cur) => cur || list[0]?.id || "");
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const current = providers.find((p) => p.id === active);
  const got = store[active] ?? {};
  const listModels = got.models ?? current?.models ?? [];
  const enabled = got.enabled ?? [];

  const patch = (next: ProviderModels): void => {
    const merged = { ...got, ...next };
    setStore({ ...store, [active]: merged });
    saveProviderModels(active, merged);
  };

  /** 存这一家的密钥（走 `secrets:set` → safeStorage 加密写；拿不到能力就拒绝写）。 */
  const saveKey = (): void => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    const refName = current?.keyRef ?? "";
    if (!value0() || !refName) {
      setKeyNote({ ok: false, text: refName ? "先填一条密钥" : "这家没有可写的密钥名（表里没登记）" });
      return;
    }
    if (!shell?.secrets?.set) {
      setKeyNote({ ok: false, text: "写密钥要在本应用里用（浏览器预览没有 IPC）" });
      return;
    }
    void shell.secrets.set(refName, value0()).then((got) => {
      if (got.ok) {
        setKeyNote({ ok: true, text: `已加密存下（${refName}）—— 下一次请求就会用它` });
        setKeyDraft("");
      } else {
        setKeyNote({ ok: false, text: got.reason ?? "写不进去" });
      }
    });
  };
  /** 当前输入框里的值（读一次，避免闭包拿到旧的）。 */
  const value0 = (): string => {
    const el = document.querySelector<HTMLInputElement>('[data-testid="wb-modelset-key"]');
    return (el?.value ?? keyDraft).trim();
  };

  /** 拉这一家真实的模型清单（名字由对方给）。 */
  const pull = (): void => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    if (!shell?.ai?.fetchModels) {
      setPulling({ id: active, note: "拉取要在本应用里用（浏览器预览没有 IPC）" });
      return;
    }
    setPulling({ id: active, note: "拉取中…" });
    void shell.ai
      .fetchModels({ providerId: active })
      .then((res) => {
        if (res.ok && res.models?.length) {
          /* 拉回来默认**全勾上**（用户拉取就是想用它们），再让他自己减 */
          patch({ models: res.models, enabled: res.models });
          setPulling(null);
        } else {
          setPulling({ id: active, note: res.error ?? "没拉到" });
        }
      })
      .catch((e) => setPulling({ id: active, note: String(e).slice(0, 100) }));
  };

  const toggleEnabled = (m: string): void => {
    const next = enabled.includes(m) ? enabled.filter((x) => x !== m) : [...enabled, m];
    patch({ enabled: next, ...(got.default && !next.includes(got.default) ? { default: undefined } : {}) });
  };

  const saved = readSavedRoute();

  return (
    <div className="wb-modelset" data-testid="wb-modelset">
      {/* 左：provider 列表 */}
      <div className="wb-modelset-list" data-testid="wb-modelset-list">
        {providers.map((p) => (
          <button
            key={p.id}
            className={`wb-modelset-row${p.id === active ? " is-on" : ""}`}
            data-testid={`wb-modelset-provider-${p.id}`}
            onClick={() => {
              setActive(p.id);
              setPulling(null);
            }}
          >
            <span className="wb-modelset-name">{p.label}</span>
            <em className={p.available ? (p.verified ? "is-ok" : "") : "is-warn"}>
              {p.available ? (p.verified ? "已验证" : "有密钥") : "无密钥"}
            </em>
          </button>
        ))}
      </div>

      {/* 右：这一家的详情 */}
      <div className="wb-modelset-detail" data-testid="wb-modelset-detail">
        {!current ? (
          <div className="wb-voice-empty">还没有可选的 provider。</div>
        ) : (
          <>
            <div className="wb-modelset-head">
              <b>{current.label}</b>
              {current.note ? <em>{current.note}</em> : null}
            </div>
            <div className="wb-modelset-keyrow">
              <span className="wb-modelset-keylabel">密钥</span>
              <input
                data-testid="wb-modelset-key"
                type="password"
                placeholder={current.keyRef ? `粘进 ${current.keyRef}（加密存，不回显）` : "这家没有可写的密钥名"}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                data-keyref={current.keyRef ?? ""}
              />
              <button className="wb-page-btn" data-testid="wb-modelset-key-save" onClick={saveKey}>
                保存
              </button>
            </div>
            {keyNote ? (
              <div className="wb-modelset-note" data-testid="wb-modelset-keynote">
                {keyNote.text}
              </div>
            ) : null}
            <div className="wb-modelset-actions">
              <button className="wb-page-btn" data-testid="wb-modelset-pull" onClick={pull}>
                <RefreshCw size={13} /> 拉取模型
              </button>
              <span className="wb-modelset-hint">
                名字由对方给（`GET /models`）——拉回来勾选的才会出现在主页那颗选择器里
              </span>
            </div>
            {pulling?.id === active ? (
              <div className="wb-modelset-note" data-testid="wb-modelset-note">
                {pulling.note}
              </div>
            ) : null}

            <div className="wb-modelset-models" data-testid="wb-modelset-models">
              {listModels.length === 0 ? (
                <div className="wb-modelset-note">还没有模型清单 —— 点上面的「拉取模型」。</div>
              ) : (
                listModels.map((m) => {
                  const on = enabled.length === 0 || enabled.includes(m);
                  const isDefault = got.default === m;
                  return (
                    <div className="wb-modelset-model" key={m}>
                      <button
                        className={`wb-modelset-check${on ? " is-on" : ""}`}
                        data-testid={`wb-modelset-toggle-${m}`}
                        aria-label={`${on ? "不启用" : "启用"} ${m}`}
                        onClick={() => toggleEnabled(m)}
                      >
                        {on ? <Check size={12} /> : null}
                      </button>
                      <span className="wb-modelset-modelname">{m}</span>
                      <button
                        className={`wb-modelset-star${isDefault ? " is-on" : ""}`}
                        data-testid={`wb-modelset-default-${m}`}
                        title={isDefault ? "已是默认模型" : "设为默认模型"}
                        onClick={() => patch({ default: m, enabled: [...new Set([...enabled, m])] })}
                      >
                        {isDefault ? "★ 默认" : "☆ 设为默认"}
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <div className="wb-modelset-foot">
              当前这一轮用的是：<b>{saved.model || "（默认通道，未指定）"}</b>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
