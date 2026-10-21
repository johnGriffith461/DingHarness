/**
 * **模型启用状态**（M-05）的存取与语义。
 *
 * 存在 `localStorage`（`dsh-canvas.model-settings`）：只有渲染侧需要它；
 * 请求该用哪家走既有的 `dsh-canvas.chat-settings`。
 *
 * ## `enabled` 的语义（2026-10-21 改正）
 *
 * 旧实现把"空数组"当成"全开"（`enabled.length === 0 || includes(m)`），
 * 于是拉取模型后默认全选 —— 主人报的第 3 条。现在：
 *
 * - `enabled: []` **就是一个都没启用**；
 * - 缺 `enabled` 字段的旧数据按当时的语义（全开）**迁移成显式全量并立刻写回**；
 * - 从未动过设置的内置 provider 仍按表里的模型清单工作（不逼老用户先去勾一遍）。
 *
 * 迁移是"读的时候做、做一次"：`readModelSettings` 发现缺字段就写回，
 * 之后 `enabled: []` 不会再被误读成全开。
 */

import type { EndpointModelCapsWire } from "@shared/providerWire";

export const MODEL_SETTINGS_KEY = "dsh-canvas.model-settings";

export type ProviderModels = {
  models?: string[];
  enabled?: string[];
  default?: string;
  /** M-07：上一次「同步模型」时端点自报的能力（按模型名）。 */
  fetched?: Record<string, EndpointModelCapsWire>;
};

export type ModelSettingsStore = Record<string, ProviderModels>;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 磁盘/内存里的原始值 → 干净 store。
 *
 * `changed` 表示"旧数据被迁移了"，调用方据此**立刻写回**。
 * 纯函数：不读写存储，单测直接喂对象。
 */
export function migrateStore(raw: unknown): { store: ModelSettingsStore; changed: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { store: {}, changed: false };
  const store: ModelSettingsStore = {};
  let changed = false;
  for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      changed = true;
      continue;
    }
    const entry = value as Record<string, unknown>;
    const models = stringsOf(entry.models);
    const enabled = stringsOf(entry.enabled);
    const fallbackDefault = typeof entry.default === "string" && entry.default ? entry.default : undefined;
    const fetched =
      entry.fetched && typeof entry.fetched === "object" && !Array.isArray(entry.fetched)
        ? (entry.fetched as Record<string, EndpointModelCapsWire>)
        : undefined;
    /*
     * 旧数据没有 `enabled`：当时的语义是"全开"。迁移成**显式全量**，
     * 这样以后再加 `enabled: []` 就不会被误读成"全开"。
     * 连 `models` 都没有的条目（从未拉取过）给空表 —— 没有可启用的东西。
     */
    const migrated = enabled ?? models ?? [];
    if (enabled === undefined) changed = true;
    store[providerId] = {
      ...(models === undefined ? {} : { models }),
      enabled: migrated,
      ...(fallbackDefault ? { default: fallbackDefault } : {}),
      ...(fetched ? { fetched } : {}),
    };
  }
  return { store, changed };
}

/** 读（带迁移 + 立刻写回）。 */
export function readModelSettings(): ModelSettingsStore {
  const store = storage();
  if (!store) return {};
  try {
    const text = store.getItem(MODEL_SETTINGS_KEY);
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    const got = migrateStore(parsed);
    if (got.changed) store.setItem(MODEL_SETTINGS_KEY, JSON.stringify(got.store));
    return got.store;
  } catch {
    return {};
  }
}

/** 写一个 provider 的整份状态。 */
export function saveProviderModels(providerId: string, value: ProviderModels): void {
  const store = storage();
  if (!store) return;
  try {
    const all = readModelSettings();
    all[providerId] = value;
    store.setItem(MODEL_SETTINGS_KEY, JSON.stringify(all));
  } catch {
    /* 存不进去也不影响这一次会话里已经生效的选择 */
  }
}

/** 删掉一个 provider 的整份状态（M-06：删供应商时级联）。 */
export function removeProviderModels(providerId: string): void {
  const store = storage();
  if (!store) return;
  try {
    const all = readModelSettings();
    if (!(providerId in all)) return;
    delete all[providerId];
    store.setItem(MODEL_SETTINGS_KEY, JSON.stringify(all));
  } catch {
    /* 同上 */
  }
}

/**
 * 拉取模型之后该怎么处理**已启用清单**。
 *
 * - 新供应商（之前没有任何设置）→ `[]`（一个都不替用户勾）；
 * - 已有供应商 → 保留**原有启用与新媒体集的交集**（下架的模型自然消失）。
 */
export function enabledAfterPull(previous: ProviderModels | undefined, pulled: readonly string[]): string[] {
  if (!previous) return [];
  const before = previous.enabled ?? previous.models ?? [];
  return pulled.filter((model) => before.includes(model));
}

/**
 * 输入区选择器该显示这一家的哪些模型。
 *
 * - 有设置：只列 `enabled`（空数组 = 一个都不显示，界面要提示去设置里勾）；
 * - 没有设置（从未动过这一页）：按 provider 表里的清单 —— 老行为不变。
 */
export function modelsForProvider(
  providerId: string,
  fromTable: readonly string[],
): { models: string[]; defaultModel?: string; hasSettings: boolean; emptyEnabled: boolean } {
  const got = readModelSettings()[providerId];
  if (!got) return { models: [...fromTable], hasSettings: false, emptyEnabled: false };
  const enabled = got.enabled ?? got.models ?? [];
  return {
    models: [...enabled],
    hasSettings: true,
    emptyEnabled: enabled.length === 0,
    ...(got.default ? { defaultModel: got.default } : {}),
  };
}
