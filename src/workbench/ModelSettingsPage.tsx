import { useEffect, useState } from "react";
import { Check, RefreshCw } from "lucide-react";

import { listProviders } from "@/ai/aiClient";
import { ModelConfigDialog } from "./ModelConfigDialog";
import { NewProviderDialog } from "./NewProviderDialog";
import { readSavedRoute } from "@/ai/route";
import { capabilityOf, formatPrice, formatTokens, groupsOf } from "@engine/runtime/modelCatalog";
import { keepTokensFor } from "@engine/runtime/budget";
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
  /** T0：正在编辑/新增的模型（null = 关着） */
  const [editing, setEditing] = useState<null | { modelId?: string }>(null);
  /** 每条声明的连通测试结果（key = `${providerId}/${modelId}`） */
  const [probeResults, setProbeResults] = useState<Record<string, { ok: boolean; text: string; busy?: boolean }>>({});
  /** T0：开着「新供应商」表单（null / true） */
  const [newProvider, setNewProvider] = useState<boolean | null>(null);
  /** 已声明的模型（来自主进程读的 models.json，与 CLI 同一份） */
  const [declared, setDeclared] = useState<import("@shared/modelConfigWire").DeclaredModelWire[]>([]);

  const reloadDeclared = (): void => {
    const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
    if (!shell) return;
    let budget = "long";
    try {
      budget = localStorage.getItem("dsh-canvas.context-budget") ?? "long";
    } catch {
      /* 读不到就用默认档位 */
    }
    void shell.modelConfig.list(budget).then((res) => setDeclared(res.models)).catch(() => undefined);
  };

  useEffect(() => {
    reloadDeclared();
  }, []);

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

  /**
   * 一个模型的"能不能干、多少钱、实际留多少"（U07，2026-10-18）。
   *
   * 口径全部来自目录表（`modelCatalog` + `budget`），**不在界面里另算** ——
   * 否则设置页与 `ding models` 会给出两个数。未登记模型标出来，不把它混进"推荐"。
   */
  const modelMeta = (m: string): string => {
    const cap = capabilityOf(m);
    const caps = [
      cap.toolCalling ? "工具" : "",
      cap.reasoning ? "思考" : "",
      cap.modalities?.includes("image") ? "读图" : "",
    ]
      .filter(Boolean)
      .join("+");
    const groups = groupsOf(cap).filter((g) => g !== "未登记");
    return [
      `窗口 ${formatTokens(cap.contextWindow)}${cap.estimated ? "（估计）" : ""}`,
      `实际留 ${formatTokens(keepTokensFor(m))}`,
      `${formatPrice(cap.priceIn)}→${formatPrice(cap.priceOut)}`,
      caps ? `支持 ${caps}` : "",
      groups.length ? groups.join(" / ") : "",
      cap.registered ? "" : "未登记",
    ]
      .filter(Boolean)
      .join(" · ");
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
        <div className="wb-card-row">
          <span className="wb-card-desc">接一个我们没内置的端点（地址 + 格式 + 密钥 → 拉模型）</span>
          <button className="wb-page-btn" data-testid="wb-modelset-new-provider" onClick={() => setNewProvider(true)}>
            + 新供应商
          </button>
        </div>
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
                <button
                  className="wb-page-btn"
                  data-testid="wb-modelset-add"
                  onClick={() => setEditing({})}
                >
                  + 添加模型
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
                        {/* U07：这个模型能干什么、多少钱、实际留多少历史（口径与 ding models 一致） */}
                        <em className="wb-modelset-meta" data-testid={`wb-modelset-meta-${m}`}>
                          {modelMeta(m)}
                        </em>
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

            {/* 卡 ②b：用户声明的模型能力（T0）—— 与 CLI 的 ding models add 同一份 models.json */}
            <div className="wb-card" data-testid="wb-modelconfig-declared">
              <div className="wb-card-head">已声明的模型能力</div>
              <div className="wb-card-note">
                这里填的窗口/输出上限会真的用到请求与历史保留上（CLI 的 <code>ding models show</code> 读到的是同一份）
              </div>
              {declared.filter((item) => item.providerId === active).length === 0 ? (
                <div className="wb-card-note">还没有声明过 —— 点上面「添加模型」。</div>
              ) : (
                declared
                  .filter((item) => item.providerId === active)
                  .map((item) => (
                    <div className="wb-modelset-model" key={item.modelId}>
                      <span className="wb-modelset-modelname">{item.modelId}</span>
                      <em className="wb-modelset-meta">历史保留 {formatTokens(item.keepTokens)} · {item.source}</em>
                      {probeResults[`${item.providerId}/${item.modelId}`] && !probeResults[`${item.providerId}/${item.modelId}`]?.busy ? (
                        <em
                          className={`wb-modelset-meta${probeResults[`${item.providerId}/${item.modelId}`]?.ok ? "" : " wb-note-bad"}`}
                          data-testid={`wb-modelconfig-probe-result-${item.modelId}`}
                        >
                          {probeResults[`${item.providerId}/${item.modelId}`]?.text}
                        </em>
                      ) : null}
                      <button
                        className="wb-page-btn"
                        data-testid={`wb-modelconfig-test-${item.modelId}`}
                        disabled={probeResults[`${item.providerId}/${item.modelId}`]?.busy}
                        onClick={() => {
                          const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
                          if (!shell) return;
                          const key = `${item.providerId}/${item.modelId}`;
                          setProbeResults((prev) => ({ ...prev, [key]: { ok: false, text: "测试中…", busy: true } }));
                          void shell.modelConfig.probe(item.providerId, item.modelId).then((res) => {
                            setProbeResults((prev) => ({
                              ...prev,
                              [key]: res.ok
                                ? { ok: true, text: `连通 ${res.elapsedMs}ms：${res.reply}` }
                                : { ok: false, text: `不通：${res.error}` },
                            }));
                          });
                        }}
                      >
                        {probeResults[`${item.providerId}/${item.modelId}`]?.busy ? "测试中…" : "测试连通"}
                      </button>
                      <button
                        className="wb-page-btn"
                        data-testid={`wb-modelconfig-edit-${item.modelId}`}
                        onClick={() => setEditing({ modelId: item.modelId })}
                      >
                        编辑
                      </button>
                      <button
                        className="wb-page-btn"
                        data-testid={`wb-modelconfig-remove-${item.modelId}`}
                        onClick={() => {
                          const shell = (globalThis as unknown as { shell?: ShellBridge }).shell;
                          if (!shell) return;
                          void shell.modelConfig.remove(item.providerId, item.modelId).then(() => reloadDeclared());
                        }}
                      >
                        删除
                      </button>
                    </div>
                  ))
              )}
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

      {newProvider ? (
        <NewProviderDialog
          bridge={(globalThis as unknown as { shell?: ShellBridge }).shell?.providers as ShellBridge["providers"]}
          onDone={(added) => {
            setNewProvider(null);
            if (added) {
              /* 新供应商加完，重新拉一次 provider 列表（它会出现在卡片里） */
              void listProviders().then((list) => setProviders(list.map((p) => ({ ...p }))));
            }
          }}
        />
      ) : null}

      {editing ? (
        <ModelConfigDialog
          bridge={(globalThis as unknown as { shell?: ShellBridge }).shell?.modelConfig as ShellBridge["modelConfig"]}
          providerId={active}
          providerLabel={current?.label ?? active}
          protocol={(current as { protocol?: string } | undefined)?.protocol ?? "openai-compatible"}
          editing={
            editing.modelId
              ? (() => {
                  const found = declared.find((item) => item.modelId === editing.modelId);
                  if (!found) return undefined;
                  return {
                    modelId: found.modelId,
                    contextWindow: found.config.properties.contextWindow,
                    maxOutputTokens: found.config.optionSpecs.maxOutputTokens.max,
                    inputFormat: found.config.properties.inputFormat,
                    supportsToolCall: found.config.properties.supportsToolCall,
                    supportsJsonSchemaOutput: found.config.properties.supportsJsonSchemaOutput,
                    supportsNativeWebSearch: found.config.properties.supportsNativeWebSearch,
                    supportsMidConversationSystem: found.config.properties.supportsMidConversationSystem,
                    reasoningLevels: found.config.optionSpecs.reasoningLevel.values,
                    reasoningMap: found.config.optionSpecs.reasoningLevel.map,
                    maxOutputMap: found.config.optionSpecs.maxOutputTokens.map,
                  };
                })()
              : undefined
          }
          onClose={(saved) => {
            setEditing(null);
            if (saved) reloadDeclared();
          }}
        />
      ) : null}
    </div>
  );
}
