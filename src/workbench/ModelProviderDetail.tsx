import { useRef, useState } from "react";
import { Clipboard, MoreHorizontal, Plus, RefreshCw, Search } from "lucide-react";

import { capabilityOf, formatTokens } from "@engine/runtime/modelCatalog";
import { resolveCapability } from "@engine/runtime/modelCapability";
import type { DeclaredModelWire } from "@shared/modelConfigWire";

import ContextMenu from "./ContextMenu";
import { badgeOf } from "./providerBadge";
import { groupByFamily } from "./modelLayout";

/**
 * 模型页的**详情面板**（M-01，照 Cherry：头部 → **Key 置顶** → 地址 → 模型区）。
 *
 * 这里只负责画与收集回调；拉取、删除、隐藏、级联都归 `ModelSettingsPage`
 * （它拿得到 shell 桥与声明清单，纯展示组件不该自己发 IPC）。
 */

export type DetailProvider = {
  id: string;
  label: string;
  note?: string;
  keyRef: string;
  models: string[];
  keySource?: "app" | "env" | "legacy" | "none";
  configured?: boolean;
  verified?: boolean;
  available?: boolean;
  baseURL?: string;
  builtin: boolean;
  hidden: boolean;
};

export type DetailProps = {
  provider: DetailProvider;
  /** 这一家已经拉回来的模型（`models`）与启用清单（`enabled`）。 */
  models: string[];
  enabled: string[];
  declared: DeclaredModelWire[];
  /** 本地设置里有没有这一家的条目（没有 = 用内置清单、默认全开）。 */
  hasSettings: boolean;
  pulling: { id: string; note: string } | null;
  keyDraft: string;
  keyNote: { ok: boolean; text: string } | null;
  onKeyDraft: (value: string) => void;
  onSaveKey: () => void;
  /** 「改用本应用保存」（env / legacy 两种来源的出口）。 */
  onAdoptKey: () => void;
  keyHint: string;
  onPull: () => void;
  onAddModel: (presetModelId?: string) => void;
  onEditModel: (modelId: string) => void;
  onRemoveDeclared: (modelId: string) => void;
  onToggleEnabled: (modelId: string) => void;
  onSetDefault: (modelId: string) => void;
  onProbe: (modelId: string) => void;
  probeResults: Record<string, { ok: boolean; text: string; busy?: boolean }>;
  defaultModel?: string;
  onEditProvider?: () => void;
  onMenu: (action: "delete" | "hide" | "unhide") => void;
  onCopy: (models: string[]) => void;
  copyNote: string;
};

export function ModelProviderDetail(props: DetailProps) {
  const {
    provider,
    models,
    enabled,
    declared,
    hasSettings,
    pulling,
    keyDraft,
    keyNote,
    onKeyDraft,
    onSaveKey,
    onAdoptKey,
    keyHint,
    onPull,
    onAddModel,
    onEditModel,
    onRemoveDeclared,
    onToggleEnabled,
    onSetDefault,
    onProbe,
    probeResults,
    defaultModel,
    onEditProvider,
    onMenu,
    onCopy,
    copyNote,
  } = props;
  const [query, setQuery] = useState("");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const keyRef = useRef<HTMLInputElement | null>(null);
  const badge = badgeOf(provider);

  /* 拉回来的清单 + 用户声明过的模型（声明过的哪怕下架了也要能编辑/删除） */
  const all = [...new Set([...models, ...declared.map((d) => d.modelId)])];
  const onSet = new Set(hasSettings ? enabled : models);
  const visible = all
    .filter((m) => (onlyEnabled ? onSet.has(m) : true))
    .filter((m) => (query.trim() ? m.toLowerCase().includes(query.trim().toLowerCase()) : true));
  const groups = groupByFamily(visible);

  const menuItems = provider.hidden
    ? [{ label: "恢复显示", run: () => onMenu("unhide") }]
    : provider.builtin
      ? [{ label: "隐藏（从模型选择器里消失）", run: () => onMenu("hide") }]
      : [{ label: "删除供应商", run: () => onMenu("delete") }];

  return (
    <div className="wb-modelset-detail" data-testid="wb-modelconfig-detail">
      <div className="wb-mset-detail-head">
        <div className="wb-mset-detail-title">
          <strong>{provider.label}</strong>
          <em className={`wb-mset-badge ${badge.className}`} title={badge.title}>
            {provider.hidden ? "已隐藏" : badge.text}
          </em>
        </div>
        <div className="wb-mset-actions">
          {onEditProvider ? (
            <button className="wb-page-btn" data-testid="wb-modelset-edit-provider" onClick={onEditProvider}>
              编辑
            </button>
          ) : null}
          <button
            className="wb-icon"
            data-testid="wb-modelset-more"
            aria-label="更多"
            title="更多"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenuAt({ x: rect.left - 120, y: rect.bottom + 4 });
            }}
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
      </div>
      {provider.note ? <div className="wb-card-note">{provider.note}</div> : null}

      {/* 第二行：API Key（Cherry 的形态 —— Key 在最上面） */}
      <div className="wb-mset-keyrow" data-testid="wb-modelset-keyrow">
        <span className="wb-mset-keylabel">API Key</span>
        <input
          ref={keyRef}
          className="wb-card-input"
          data-testid="wb-modelset-key"
          type="password"
          placeholder={provider.keyRef || "这家没有可写的密钥名"}
          value={keyDraft}
          onChange={(event) => onKeyDraft(event.target.value)}
        />
        <button className="wb-page-btn" data-testid="wb-modelset-key-save" onClick={onSaveKey}>
          保存
        </button>
        {provider.keySource === "env" || provider.keySource === "legacy" ? (
          <button
            className="wb-page-btn"
            data-testid="wb-modelset-adopt-key"
            onClick={() => {
              onAdoptKey();
              keyRef.current?.focus();
            }}
          >
            改用本应用保存
          </button>
        ) : null}
      </div>
      {keyHint ? (
        <div className="wb-card-note" data-testid="wb-modelset-keyhint">
          {keyHint}
        </div>
      ) : null}
      {keyNote ? (
        <div className={`wb-card-note${keyNote.ok ? "" : " wb-note-bad"}`} data-testid="wb-modelset-keynote">
          {keyNote.text}
        </div>
      ) : null}

      {/* 第三行：API 地址（内置不可改；自定义走「编辑」） */}
      <div className="wb-mset-rowline" data-testid="wb-modelset-baseurl-row">
        <span className="wb-card-label">API 地址</span>
        <code className="wb-mset-baseurl">{provider.baseURL ?? "（按内核默认）"}</code>
        <span className="wb-card-note">{provider.builtin ? "内置供应商，地址不可改" : "自定义供应商，可用上面的「编辑」改"}</span>
      </div>

      {/* 第四行起：模型区 */}
      <div className="wb-mset-models-head">
        <strong>模型</strong>
        <div className="wb-mset-actions">
          <button
            className="wb-icon"
            title="复制模型清单（JSON）"
            aria-label="复制模型清单"
            data-testid="wb-modelset-copy"
            onClick={() => onCopy(all)}
          >
            <Clipboard size={14} />
          </button>
          <div className="wb-mset-search wb-mset-search-inline">
            <Search size={12} />
            <input
              data-testid="wb-modelset-model-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索模型…"
              spellCheck={false}
            />
          </div>
          <button
            className={`wb-page-btn${onlyEnabled ? " wb-page-btn-primary" : ""}`}
            data-testid="wb-modelset-only-enabled"
            onClick={() => setOnlyEnabled((v) => !v)}
          >
            只看已启用
          </button>
          <button className="wb-page-btn" data-testid="wb-modelset-pull" onClick={onPull}>
            <RefreshCw size={13} /> 同步模型
          </button>
          <button className="wb-page-btn" data-testid="wb-modelset-add" onClick={() => onAddModel()}>
            <Plus size={13} /> 添加模型
          </button>
        </div>
      </div>
      {copyNote ? <div className="wb-card-note">{copyNote}</div> : null}
      {pulling?.id === provider.id ? (
        <div className="wb-card-note" data-testid="wb-modelset-note">
          {pulling.note}
        </div>
      ) : null}

      <div className="wb-modelset-models" data-testid="wb-modelset-models">
        {all.length === 0 ? (
          <div className="wb-card-note">还没有模型清单 —— 点「同步模型」。</div>
        ) : visible.length === 0 ? (
          <div className="wb-card-note">没有匹配的模型。</div>
        ) : (
          groups.map((group) => (
            <div className="wb-mset-group" key={group.family} data-testid={`wb-modelset-group-${group.family}`}>
              <div className="wb-mset-group-head">{group.family}</div>
              {group.models.map((model) => {
                const on = onSet.has(model);
                /* M-07：窗口/输出/能力以**目录快照**为准（手核条目优先），价格仍看旧目录 */
                const cap = resolveCapability({ providerId: provider.id, modelId: model });
                const price = capabilityOf(model, { provider: provider.id });
                const isDefault = defaultModel === model;
                const probe = probeResults[`${provider.id}/${model}`];
                const declaredHere = declared.some((d) => d.modelId === model);
                return (
                  <div className="wb-modelset-model" key={model}>
                    <button
                      className={`wb-modelset-check${on ? " is-on" : ""}`}
                      data-testid={`wb-modelset-toggle-${model}`}
                      aria-label={`${on ? "不启用" : "启用"} ${model}`}
                      onClick={() => onToggleEnabled(model)}
                    >
                      {on ? "✓" : ""}
                    </button>
                    <span className="wb-modelset-modelname">{model}</span>
                    <span className="wb-mset-caps">
                      {cap.reasoning ? <em className="wb-mset-cap">思考</em> : null}
                      {cap.toolCall ? <em className="wb-mset-cap">工具</em> : null}
                      {cap.inputModalities.includes("image") ? <em className="wb-mset-cap">视觉</em> : null}
                      {cap.inputModalities.includes("audio") ? <em className="wb-mset-cap">音频</em> : null}
                      {price.priceIn === 0 ? <em className="wb-mset-cap">免费</em> : null}
                    </span>
                    <em className="wb-modelset-meta" data-testid={`wb-modelset-meta-${model}`}>
                      窗口 {formatTokens(cap.contextWindow)}
                      {cap.sources.maxOutput === "default" ? "" : ` · 输出 ${formatTokens(cap.maxOutput)}`}
                      {cap.source === "default" ? " · 未登记（默认值，请核对）" : ""}
                    </em>
                    {probe && !probe.busy ? (
                      <em className={`wb-mset-meta${probe.ok ? "" : " wb-note-bad"}`}>{probe.text}</em>
                    ) : null}
                    <button
                      className="wb-page-btn"
                      data-testid={`wb-modelset-probe-${model}`}
                      disabled={probe?.busy}
                      onClick={() => onProbe(model)}
                    >
                      {probe?.busy ? "测试中…" : "测试"}
                    </button>
                    <button
                      className={`wb-modelset-star${isDefault ? " is-on" : ""}`}
                      data-testid={`wb-modelset-default-${model}`}
                      title={isDefault ? "已是默认模型" : "设为默认模型"}
                      onClick={() => onSetDefault(model)}
                    >
                      {isDefault ? "★ 默认" : "☆ 设为默认"}
                    </button>
                    <button
                      className="wb-page-btn"
                      data-testid={`wb-modelconfig-${declaredHere ? "edit" : "add"}-${model}`}
                      onClick={() => (declaredHere ? onEditModel(model) : onAddModel(model))}
                      title={declaredHere ? "编辑这条声明" : "为它添加一条声明"}
                    >
                      {declaredHere ? "编辑" : "声明"}
                    </button>
                    {declaredHere ? (
                      <button
                        className="wb-page-btn"
                        data-testid={`wb-modelconfig-remove-${model}`}
                        onClick={() => onRemoveDeclared(model)}
                        title="删掉这条模型声明（不影响这个模型是否能启用）"
                      >
                        删声明
                      </button>
                    ) : null}
                    <button
                      className="wb-page-btn"
                      data-testid={`wb-modelset-disable-${model}`}
                      onClick={() => onToggleEnabled(model)}
                      title="停用（从输入区选择器里消失）"
                    >
                      −
                    </button>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {menuAt ? (
        <ContextMenu
          items={menuItems}
          x={menuAt.x}
          y={menuAt.y}
          testid="wb-modelset-menu"
          onClose={() => setMenuAt(null)}
        />
      ) : null}
    </div>
  );
}
