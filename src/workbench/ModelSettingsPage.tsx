import { useEffect, useState } from "react";
import { Check, RefreshCw } from "lucide-react";

import { listProviders } from "@/ai/aiClient";
import { readSavedRoute } from "@/ai/route";
import type { ShellBridge } from "@shared/ipc";

/**
 * 设置 →「模型」（2026-10-16 第二版 —— **卡片化**，照 ZCode 的 settings 卡片）。
 *
 * ## ZCode 的卡片长什么样（主人给的对照图二）
 *
 * 每块设置是一张卡：**左边「标签 + 一句说明」，右边是控件**（下拉 / 开关 / 输入 + 保存）；
 * 一块卡里可以有多行（图二里「终端字体」那张就是"说明 + 输入 + 保存"）。
 *
 * 所以这一页现在是三张卡（`.wb-card` / `.wb-card-row` / `.wb-card-label` / `.wb-card-desc`）：
 *   ① **provider**：一家一行（名字 + 状态：有密钥 / 已验证 / 无密钥）；
 *   ② **模型清单**：拉取 + 勾选 + 设默认（行尾「★ 设为默认」）；
 *   ③ **密钥**：输入 + 保存 + 如实回报（拿不到系统加密能力时原样说「拒绝写」）。
 *
 * 存的仍是 `localStorage`（`dsh-canvas.model-settings`）：只有渲染侧需要它；
 * 请求该用哪家走既有的 `dsh-canvas.chat-settings`。密钥值走 `secrets:set`（主进程加密写），
 * **不回传、不落前端**。
 */

const KEY = "dsh-canvas.model-settings";

export type ProviderModels = {
  models?: string[];
  enabled?: string[];
  default?: string;
};

type Store = Record<string, ProviderModels>;

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
 * 主页选择器该显示这一家的哪些模型：**勾选过的 > 拉回来的 > 表里写死的**。
 * 没动过这一页时行为与以前一模一样。
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
    Array<{
      id: string;
      label: string;
      models: string[];
      available: boolean;
      verified?: boolean;
      note?: string;
      keyRef?: string;
    }>
  >([]);
  const [active, setActive] = useState("");
  const [pulling, setPulling] = useState<{ id: string; note: string } | null>(null);
  const [store, setStore] = useState<Store>(() => readModelSettings());
  /** 正在输入的密钥（保存后清空：值不留在前端）。 */
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
  const saved = readSavedRoute();
  const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

  const patch = (next: ProviderModels): void => {
    const merged = { ...got, ...next };
    setStore({ ...store, [active]: merged });
    saveProviderModels(active, merged);
  };

  /** 拉对方真实的模型清单（名字由对方给，不由我们猜）。 */
  const pull = (): void => {
    const b = bridge();
    if (!b?.ai?.fetchModels) {
      setPulling({ id: active, note: "拉取要在本应用里用（浏览器预览没有 IPC）" });
      return;
    }
    setPulling({ id: active, note: "拉取中…" });
    void b.ai
      .fetchModels({ providerId: active })
      .then((res) => {
        if (res.ok && res.models?.length) {
          patch({ models: res.models, enabled: res.models });
          setPulling(null);
        } else {
          setPulling({ id: active, note: res.error ?? "没拉到（对方没给清单，也没说原因）" });
        }
      })
      .catch((e) => setPulling({ id: active, note: String(e).slice(0, 100) }));
  };

  const toggleEnabled = (m: string): void => {
    const next = enabled.includes(m) ? enabled.filter((x) => x !== m) : [...enabled, m];
    patch({ enabled: next, ...(got.default && !next.includes(got.default) ? { default: undefined } : {}) });
  };

  /** 存这一家的密钥（走 `secrets:set` → safeStorage 加密写；拿不到能力就拒绝写）。 */
  const saveKey = (): void => {
    const b = bridge();
    const refName = current?.keyRef ?? "";
    const value = keyDraft.trim();
    if (!value || !refName) {
      setKeyNote({ ok: false, text: refName ? "先填一条密钥" : "这家没有可写的密钥名（表里没登记）" });
      return;
    }
    if (!b?.secrets?.set) {
      setKeyNote({ ok: false, text: "写密钥要在本应用里用（浏览器预览没有 IPC）" });
      return;
    }
    void b.secrets.set(refName, value).then((res) => {
      if (res.ok) {
        setKeyNote({ ok: true, text: `已加密存下（${refName}）—— 下一次请求就会用它` });
        setKeyDraft("");
      } else {
        setKeyNote({ ok: false, text: res.reason ?? "写不进去" });
      }
    });
  };

  return (
    <div className="wb-modelset" data-testid="wb-modelset">
      {/* 卡 ①：provider 列表 */}
      <div className="wb-modelset-list wb-card" data-testid="wb-modelset-list">
        <div className="wb-card-head">provider</div>
        {providers.map((p) => (
          <button
            key={p.id}
            className={`wb-modelset-row${p.id === active ? " is-on" : ""}`}
            data-testid={`wb-modelset-provider-${p.id}`}
            onClick={() => {
              setActive(p.id);
              setPulling(null);
              setKeyNote(null);
            }}
          >
            <span className="wb-modelset-name">{p.label}</span>
            <em className={p.available ? (p.verified ? "is-ok" : "") : "is-warn"}>
              {p.available ? (p.verified ? "已验证" : "有密钥") : "无密钥"}
            </em>
          </button>
        ))}
      </div>

      {/* 卡 ②③：这一家的详情（ZCode：标签 + 说明在左，控件在右） */}
      <div className="wb-modelset-detail">
        {!current ? (
          <div className="wb-card wb-card-note">还没有可选的 provider。</div>
        ) : (
          <>
            <div className="wb-card">
              <div className="wb-card-head">{current.label}</div>
              {current.note ? <div className="wb-card-note">{current.note}</div> : null}
              <div className="wb-card-row">
                <span className="wb-card-label">模型清单</span>
                <span className="wb-card-desc">
                  名字由对方给（拉一次 <code>GET /models</code>）；拉回来勾选的才会出现在输入区那颗选择器里
                </span>
                <button className="wb-page-btn" data-testid="wb-modelset-pull" onClick={pull}>
                  <RefreshCw size={13} /> 拉取模型
                </button>
              </div>
              {pulling?.id === active ? (
                <div className="wb-card-note" data-testid="wb-modelset-note">
                  {pulling.note}
                </div>
              ) : null}
              <div className="wb-modelset-models" data-testid="wb-modelset-models">
                {listModels.length === 0 ? (
                  <div className="wb-card-note">还没有模型清单 —— 点上面的「拉取模型」。</div>
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
            </div>

            {/* 卡 ③：密钥 */}
            <div className="wb-card">
              <div className="wb-card-row">
                <span className="wb-card-label">密钥</span>
                <span className="wb-card-desc">
                  加密存在本机（走系统保护：DPAPI / Keychain / secret-service）；拿不到系统保护时拒绝写，不退化成明文
                </span>
                <input
                  className="wb-card-input"
                  data-testid="wb-modelset-key"
                  type="password"
                  placeholder={current.keyRef ? current.keyRef : "这家没有可写的密钥名"}
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                />
                <button className="wb-page-btn" data-testid="wb-modelset-key-save" onClick={saveKey}>
                  保存
                </button>
              </div>
              {keyNote ? (
                <div className="wb-card-note" data-testid="wb-modelset-keynote">
                  {keyNote.text}
                </div>
              ) : null}
              <div className="wb-card-note">
                当前这一轮用的是：<b>{saved.model || "（默认通道，未指定）"}</b>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
