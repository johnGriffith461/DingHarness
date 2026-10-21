import { useEffect, useState } from "react";

import { listProviders } from "@/ai/aiClient";
import { readSavedRoute } from "@/ai/route";
import { getProvider, isBuiltinProviderId } from "@engine/runtime/providers";
import type { ShellBridge } from "@shared/ipc";
import type { DeclaredModelWire } from "@shared/modelConfigWire";
import type { CustomProviderWire } from "@shared/providerWire";

import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { ModelConfigDialog } from "./ModelConfigDialog";
import { ModelProviderDetail } from "./ModelProviderDetail";
import { ModelProviderList } from "./ModelProviderList";
import { NewProviderDialog } from "./NewProviderDialog";
import { useAppSettings } from "./appSettings";
import { cascadePlan } from "./providerCascade";
import {
  enabledAfterPull,
  readModelSettings,
  removeProviderModels,
  saveProviderModels,
  type ModelSettingsStore,
} from "./modelSettingsStore";

/**
 * 设置 →「模型」（M-01..M-07，2026-10-21 重做）。
 *
 * ## 形状（照 Cherry 的三段式）
 *
 * ```
 * 左列：搜索 + provider 行（状态点）+ 底部「＋ 添加供应商」
 * 右侧：名字 / 状态 → **API Key（置顶）** → API 地址 → 模型区（分组 + 徽标）
 * ```
 *
 * 上一版把 provider 列表塞进内容区左上角、Key 放页底、能力另起一卡 —— 那三处正是
 * 主人报的问题形状。这里把状态集中到一个页面状态里，列表与详情都只读它。
 *
 * ## 数据来自哪
 *
 * - provider / 密钥来源：主进程 `ai:listProviders`（M-02 的 `keySource`）；
 * - 模型声明：`models.json`（与 `ding models` 同一份）；
 * - 启用清单 / 端点能力：`localStorage` 的 `dsh-canvas.model-settings`（M-05/M-07）；
 * - 隐藏名单：`appSettings.hiddenProviders`（M-06）。
 */

type ProviderRow = Awaited<ReturnType<typeof listProviders>>[number];

export function ModelSettingsPage() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [active, setActive] = useState("");
  const [store, setStore] = useState<ModelSettingsStore>(() => readModelSettings());
  const [declared, setDeclared] = useState<DeclaredModelWire[]>([]);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const hiddenProviders = useAppSettings((s) => s.hiddenProviders);
  const [pulling, setPulling] = useState<{ id: string; note: string } | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyNote, setKeyNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [keyHint, setKeyHint] = useState("");
  const [probeResults, setProbeResults] = useState<Record<string, { ok: boolean; text: string; busy?: boolean }>>({});
  const [editingModel, setEditingModel] = useState<null | { modelId?: string }>(null);
  const [editingProvider, setEditingProvider] = useState<CustomProviderWire | null>(null);
  const [newProvider, setNewProvider] = useState(false);
  const [copyNote, setCopyNote] = useState("");
  const [pageNote, setPageNote] = useState("");
  const [confirm, setConfirm] = useState<null | { request: ConfirmRequest; run: () => Promise<void> }>(null);

  const bridge = (): ShellBridge | undefined => (globalThis as unknown as { shell?: ShellBridge }).shell;

  const reloadDeclared = (): void => {
    const shell = bridge();
    if (!shell) return;
    let budget = "long";
    try {
      budget = localStorage.getItem("dsh-canvas.context-budget") ?? "long";
    } catch {
      /* 读不到就用默认档位 */
    }
    void shell.modelConfig
      .list(budget)
      .then((res) => setDeclared(res.models))
      .catch(() => undefined);
  };

  const reloadProviders = async (): Promise<void> => {
    try {
      const list = await listProviders();
      setProviders(list.map((p) => ({ ...p })));
    } catch {
      /* 读不到就保持上一份 —— 页面上会有旧数据，但不会崩 */
    }
  };

  useEffect(() => {
    reloadDeclared();
    void reloadProviders();
    setStore(readModelSettings());
  }, []);

  const isHidden = (id: string): boolean => hiddenProviders.includes(id);
  const visible = providers.filter((p) => showHidden || !isHidden(p.id));
  const filtered = query.trim()
    ? visible.filter((p) => p.id.toLowerCase().includes(query.trim().toLowerCase()) || p.label.toLowerCase().includes(query.trim().toLowerCase()))
    : visible;
  const current = visible.find((p) => p.id === active) ?? filtered[0] ?? visible[0];
  const entry = current ? store[current.id] : undefined;
  const configuredModels = entry?.models ?? current?.models ?? [];
  /* 没有本地设置 = 从未动过这一页 → 按内置清单全开（老行为不变） */
  const enabled = entry ? (entry.enabled ?? []) : [...configuredModels];
  const declaredHere = declared.filter((item) => item.providerId === current?.id);
  const savedRoute = readSavedRoute();

  const patch = (providerId: string, next: Partial<ModelSettingsStore[string]>): void => {
    const previous = readModelSettings()[providerId] ?? {};
    saveProviderModels(providerId, { ...previous, ...next });
    setStore(readModelSettings());
  };

  const selectProvider = (id: string): void => {
    setActive(id);
    setPulling(null);
    setKeyNote(null);
    setKeyHint("");
    setKeyDraft("");
    setCopyNote("");
    setPageNote("");
  };

  /** 同步模型：拉清单 + 端点自报能力；**启用清单保留交集**（新供应商为空）。 */
  const pull = async (): Promise<void> => {
    if (!current) return;
    const shell = bridge();
    if (!shell?.ai?.fetchModels) {
      setPulling({ id: current.id, note: "拉取要在本应用里用（浏览器预览没有 IPC）" });
      return;
    }
    setPulling({ id: current.id, note: "同步中…" });
    try {
      const res = await shell.ai.fetchModels({ providerId: current.id });
      if (!res.ok || !res.models?.length) {
        setPulling({ id: current.id, note: res.error ?? "没拉到（对方没给清单，也没说原因）" });
        return;
      }
      const previous = readModelSettings()[current.id];
      const nextEnabled = enabledAfterPull(previous, res.models);
      patch(current.id, {
        models: res.models,
        enabled: nextEnabled,
        ...(res.caps && Object.keys(res.caps).length ? { fetched: res.caps } : {}),
      });
      setPulling({
        id: current.id,
        note: `拉回 ${res.models.length} 个模型；已启用 ${nextEnabled.length} 个（没替你勾任何新的）`,
      });
    } catch (error) {
      setPulling({ id: current.id, note: `拉取失败：${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const toggleEnabled = (modelId: string): void => {
    if (!current) return;
    const on = enabled.includes(modelId);
    const next = on ? enabled.filter((m) => m !== modelId) : [...enabled, modelId];
    patch(current.id, {
      enabled: next,
      ...(entry?.default && !next.includes(entry.default) ? { default: undefined } : {}),
    });
  };

  const setDefault = (modelId: string): void => {
    if (!current) return;
    patch(current.id, { default: modelId, enabled: [...new Set([...enabled, modelId])] });
  };

  const saveKey = (): void => {
    if (!current) return;
    const shell = bridge();
    const value = keyDraft.trim();
    if (!value) {
      setKeyNote({ ok: false, text: "先填一条密钥" });
      return;
    }
    if (!shell?.secrets?.set) {
      setKeyNote({ ok: false, text: "写密钥要在本应用里用（浏览器预览没有 IPC）" });
      return;
    }
    void shell.secrets.set(current.keyRef, value).then(async (res) => {
      if (res.ok) {
        setKeyNote({ ok: true, text: `已加密存下（${current.keyRef}）—— 下一次请求就会用它` });
        setKeyDraft("");
        setKeyHint("");
        await reloadProviders();
      } else {
        setKeyNote({ ok: false, text: res.reason ?? "写不进去" });
      }
    });
  };

  const adoptKey = (): void => {
    if (!current) return;
    const where = current.keySource === "env" ? `环境变量 ${current.keyRef}` : "旧目录 ~/.dsh";
    setKeyHint(`这条 key 目前来自${where}，保存一条会优先用它。`);
  };

  const probe = (modelId: string): void => {
    if (!current) return;
    const shell = bridge();
    if (!shell) return;
    const key = `${current.id}/${modelId}`;
    setProbeResults((prev) => ({ ...prev, [key]: { ok: false, text: "测试中…", busy: true } }));
    void shell.modelConfig.probe(current.id, modelId).then((res) => {
      setProbeResults((prev) => ({
        ...prev,
        [key]: res.ok
          ? { ok: true, text: `连通 ${res.elapsedMs}ms：${res.reply}` }
          : { ok: false, text: `不通：${res.error}` },
      }));
    });
  };

  const removeDeclared = (modelId: string): void => {
    if (!current) return;
    const shell = bridge();
    if (!shell) return;
    void shell.modelConfig.remove(current.id, modelId).then(() => reloadDeclared());
  };

  const copyModels = (models: string[]): void => {
    void navigator.clipboard
      ?.writeText(JSON.stringify(models, null, 1))
      .then(() => setCopyNote(`已复制 ${models.length} 个模型名（JSON）`))
      .catch(() => setCopyNote("复制失败（剪贴板不可用）"));
  };

  /** 删除 / 隐藏（M-06）：先算级联，再让用户确认。 */
  const askRemove = (action: "delete" | "hide" | "unhide"): void => {
    if (!current) return;
    const settings = useAppSettings.getState();
    if (action === "unhide") {
      setConfirm({
        request: {
          title: `恢复「${current.label}」？`,
          message: "它会重新出现在模型选择器里（供应商本身一直在）。",
          confirmLabel: "恢复显示",
        },
        run: async () => {
          await settings.unhideProvider(current.id);
          setPageNote("已恢复显示");
        },
      });
      return;
    }
    const plan = cascadePlan(current.id, { declared, settings: store, keyRef: current.keyRef });
    if (plan.action === "hide") {
      setConfirm({
        request: {
          title: `隐藏「${current.label}」？`,
          message: "它会从模型选择器里消失，但配置与密钥都还在。设置里随时能恢复。",
          detail: "内置供应商不能删除（删了下次启动还会回来），所以这里只做隐藏。",
          confirmLabel: "隐藏",
        },
        run: async () => {
          await settings.hideProvider(current.id);
          setPageNote("已隐藏（可从左列「显示已隐藏」恢复）");
        },
      });
      return;
    }
    setConfirm({
      request: {
        title: `删除「${current.label}」？`,
        message: `会一并删掉：${plan.declaredModels.length} 个模型声明、${plan.enabledCount} 个已启用模型。`,
        detail:
          "已产生的会话不受影响。密钥会从本应用凭据库移除；环境变量与 ~/.dsh 里的那条不归我们删。",
        confirmLabel: "删除供应商",
        danger: true,
      },
      run: async () => {
        const shell = bridge();
        if (!shell) return;
        let failed = 0;
        for (const modelId of plan.declaredModels) {
          const got = await shell.modelConfig.remove(current.id, modelId);
          if (!got.ok) failed += 1;
        }
        const removed = await shell.providers.remove(current.id);
        if (!removed.ok) {
          setPageNote(`没能删掉供应商：${removed.error ?? "未知原因"}`);
          return;
        }
        removeProviderModels(current.id);
        setStore(readModelSettings());
        const keyGot = plan.keyRef ? await shell.secrets?.remove(plan.keyRef) : undefined;
        await reloadProviders();
        reloadDeclared();
        const rest = providers.filter((p) => p.id !== current.id);
        setActive(rest[0]?.id ?? "");
        const bits = [
          `已删除「${current.label}」`,
          plan.declaredModels.length ? `清掉 ${plan.declaredModels.length} 条声明` : "",
          keyGot?.removed.length ? `密钥已从 ${keyGot.removed.join(" / ")} 移除` : plan.keyRef ? "本应用凭据库里没有这条 key（环境变量/旧目录不归我们删）" : "",
          failed ? `有 ${failed} 条声明没删掉（models.json 可能被占用）` : "",
        ].filter(Boolean);
        setPageNote(bits.join("；"));
      },
    });
  };

  const dialogEditing = editingModel?.modelId
    ? (() => {
        const found = declared.find((item) => item.providerId === current?.id && item.modelId === editingModel.modelId);
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
    : undefined;

  return (
    <div className="wb-modelset-page" data-testid="wb-modelset">
      <div className="wb-modelset">
        <ModelProviderList
        rows={filtered.map((p) => ({
          id: p.id,
          label: p.label,
          ...(p.keySource ? { keySource: p.keySource } : {}),
          ...(p.configured === undefined ? {} : { configured: p.configured }),
          ...(p.verified === undefined ? {} : { verified: p.verified }),
          available: p.available,
          keyRef: p.keyRef,
          hidden: isHidden(p.id),
        }))}
        active={current?.id ?? ""}
        query={query}
        onQueryChange={setQuery}
        onSelect={selectProvider}
        onAdd={() => setNewProvider(true)}
        hiddenCount={providers.filter((p) => isHidden(p.id)).length}
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden((v) => !v)}
      />

      {!current ? (
        <div className="wb-modelset-detail">
          <div className="wb-card wb-card-note">还没有可选的 provider —— 点左下的「添加供应商」。</div>
        </div>
      ) : (
        <ModelProviderDetail
          provider={{
            id: current.id,
            label: current.label,
            ...(current.note ? { note: current.note } : {}),
            keyRef: current.keyRef,
            models: current.models,
            ...(current.keySource ? { keySource: current.keySource } : {}),
            ...(current.configured === undefined ? {} : { configured: current.configured }),
            ...(current.verified === undefined ? {} : { verified: current.verified }),
            available: current.available,
            ...(current.baseURL ? { baseURL: current.baseURL } : {}),
            builtin: isBuiltinProviderId(current.id),
            hidden: isHidden(current.id),
          }}
          models={configuredModels}
          enabled={enabled}
          declared={declaredHere}
          hasSettings={Boolean(entry)}
          pulling={pulling}
          keyDraft={keyDraft}
          keyNote={keyNote}
          onKeyDraft={setKeyDraft}
          onSaveKey={saveKey}
          onAdoptKey={adoptKey}
          keyHint={keyHint}
          onPull={() => void pull()}
          onAddModel={(preset) => setEditingModel({ ...(preset ? { modelId: preset } : {}) })}
          onEditModel={(modelId) => setEditingModel({ modelId })}
          onRemoveDeclared={removeDeclared}
          onToggleEnabled={toggleEnabled}
          onSetDefault={setDefault}
          onProbe={probe}
          probeResults={probeResults}
          defaultModel={entry?.default}
          onEditProvider={
            isBuiltinProviderId(current.id)
              ? undefined
              : () => {
                  const custom = providers.find((p) => p.id === current.id);
                  if (!custom) return;
                  setEditingProvider({
                    id: custom.id,
                    label: custom.label,
                    baseURL: custom.baseURL ?? "",
                    protocol: (getProvider(custom.id)?.protocol ?? "openai-compatible") as CustomProviderWire["protocol"],
                    models: configuredModels,
                    keyRef: custom.keyRef,
                  });
                }
          }
          onMenu={(action) => askRemove(action)}
          onCopy={copyModels}
          copyNote={copyNote}
        />
      )}
      </div>

      {pageNote ? (
        <div className="wb-mset-pagenote" data-testid="wb-modelset-pagenote">
          {pageNote}
        </div>
      ) : null}
      <div className="wb-mset-now">
        当前这一轮用的是：<b>{savedRoute.model ? `${savedRoute.provider}/${savedRoute.model}` : "（默认通道，未指定）"}</b>
      </div>

      {newProvider ? (
        <NewProviderDialog
          bridge={(bridge()?.providers ?? {}) as ShellBridge["providers"]}
          onDone={(added, id) => {
            setNewProvider(false);
            if (added) {
              void reloadProviders().then(() => {
                if (id) setActive(id);
              });
              setStore(readModelSettings());
            }
          }}
        />
      ) : null}

      {editingProvider ? (
        <NewProviderDialog
          bridge={(bridge()?.providers ?? {}) as ShellBridge["providers"]}
          editing={editingProvider}
          onDone={(saved) => {
            setEditingProvider(null);
            if (saved) {
              void reloadProviders();
              setStore(readModelSettings());
            }
          }}
        />
      ) : null}

      {editingModel && current ? (
        <ModelConfigDialog
          bridge={bridge()?.modelConfig as ShellBridge["modelConfig"]}
          providerId={current.id}
          providerLabel={current.label}
          protocol={(getProvider(current.id)?.protocol ?? "openai-compatible") as string}
          {...(dialogEditing ? { editing: dialogEditing } : {})}
          {...(!dialogEditing && editingModel.modelId ? { initialModelId: editingModel.modelId } : {})}
          models={dialogEditing ? [] : configuredModels}
          {...(entry?.fetched ? { fetched: entry.fetched } : {})}
          onPullModels={async () => {
            const shell = bridge();
            if (!shell?.ai?.fetchModels) throw new Error("拉取要在本应用里用");
            const res = await shell.ai.fetchModels({ providerId: current.id });
            if (!res.ok || !res.models?.length) throw new Error(res.error ?? "没拉到模型清单");
            const previous = readModelSettings()[current.id];
            patch(current.id, {
              models: res.models,
              enabled: enabledAfterPull(previous, res.models),
              ...(res.caps && Object.keys(res.caps).length ? { fetched: res.caps } : {}),
            });
            return res.models;
          }}
          onClose={(saved) => {
            setEditingModel(null);
            if (saved) {
              reloadDeclared();
              setStore(readModelSettings());
            }
          }}
        />
      ) : null}

      {confirm ? (
        <ConfirmDialog
          request={confirm.request}
          onAnswer={(ok) => {
            const action = confirm.run;
            setConfirm(null);
            if (ok) void action();
          }}
        />
      ) : null}
    </div>
  );
}

/* ── 兼容导出（旧调用点：ModelChip 曾从这里取） ── */
export { readModelSettings, saveProviderModels, modelsForProvider } from "./modelSettingsStore";
export type { ProviderModels } from "./modelSettingsStore";
