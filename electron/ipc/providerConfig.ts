import { ipcMain } from "electron";

import { customProviders, setCustomProviders, type CustomProviderInput } from "../../engine/runtime/providers";
import { writeSecret } from "../../hosts/cli/wizard";
import { readConfig, writeConfig, type CliConfig } from "../../hosts/cli/config";
import { fetchModelsFor } from "./aiProbe";
import type { ProviderAddInput, ProviderAddResult, ProviderFormatWire, CustomProviderWire } from "../../shared/providerWire";

/**
 * **自定义供应商的桌面 IPC**（T0「新供应商」）。
 *
 * ## 它解决什么
 *
 * 以前接一个新中转站只能编辑 `config.json` 或跑 `ding providers add`。
 * 现在用户在设置里填地址、选格式、填密钥、拉模型、勾几个即可。
 *
 * ## 两条硬规矩
 *
 * 1. **密钥只在这一次调用里出现**：主进程收到就写进凭据库（`writeSecret`），
 *    返回值里不含它，渲染层也从不回读。
 * 2. **id 由名字派生，用户不用管**：但派生规则必须与 CLI 的一致，
 *    否则"界面上加的"和"CLI 里加的"会变成两家。
 */

export const PROVIDER_CHANNEL = {
  listCustom: "provider:listCustom",
  fetchModels: "provider:fetchModels",
  add: "provider:add",
  remove: "provider:remove",
} as const;

/** 名 → id：小写、非字母数字换成连字符、去重。与 `setCustomProviders` 的校验规则对齐。 */
export function idFromLabel(label: string, existing: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "custom";
  const safe = /^[a-z]/.test(base) ? base : `p-${base}`;
  if (!existing.includes(safe)) return safe;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${safe}-${n}`.slice(0, 40);
    if (!existing.includes(candidate)) return candidate;
  }
  return `${safe}-${Date.now()}`.slice(0, 40);
}

/** 密钥引用名：`<ID大写>_API_KEY`，与内置 provider 的命名习惯一致（`A_API_KEY` 那种）。 */
export function keyRefForProvider(id: string): string {
  return `${id.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_API_KEY`;
}

/** 这三种格式与内核协议一一对应（表单里只列这三种）。 */
function protocolOfFormat(format: ProviderFormatWire): CustomProviderInput["protocol"] {
  return format;
}

function toWire(input: CustomProviderInput): CustomProviderWire {
  return {
    id: input.id,
    label: input.label,
    baseURL: input.baseURL,
    protocol: input.protocol as ProviderFormatWire,
    models: input.models,
    keyRef: input.keyRef,
  };
}

/** 列出用户自己加的供应商（从磁盘的 config.json 读，不只看进程内那批）。 */
export function listCustomProviders(dataDir: string): CustomProviderWire[] {
  const { config } = readConfig(dataDir);
  return (config.providers ?? []).map(toWire);
}

/**
 * 保存一个新供应商：校验 → 写密钥 → 写 config → 立刻生效。
 *
 * ⚠️ **顺序**：先写密钥再写配置。反过来的话，配置生效的那一刻密钥还没有，
 * 中间那几毫秒里任何一次调用都会报"没有可用密钥"——虽然短，但排查起来很费劲。
 */
export function addCustomProvider(dataDir: string, input: ProviderAddInput): ProviderAddResult {
  try {
    const label = input.label.trim();
    if (!label) return { ok: false, error: "供应商名字不能为空" };
    if (!/^https?:\/\//.test(input.baseURL.trim())) {
      return { ok: false, error: "Base URL 必须是 http(s) 地址" };
    }
    if (!input.models.length) return { ok: false, error: "至少选一个模型（否则用不了）" };
    if (!input.apiKey.trim()) return { ok: false, error: "API Key 不能为空" };

    const { config } = readConfig(dataDir);
    const existing = (config.providers ?? []).map((p) => p.id);
    const id = idFromLabel(label, existing);
    const keyRef = keyRefForProvider(id);

    const entry: CustomProviderInput = {
      id,
      label,
      baseURL: input.baseURL.trim(),
      protocol: protocolOfFormat(input.format),
      keyRef,
      models: [...new Set(input.models.map((m) => m.trim()).filter(Boolean))],
    };

    /* 先用内核那份校验过一遍（同名/字段问题的唯一实现） */
    const providers = [...(config.providers ?? []).filter((p) => p.id !== id), entry];
    const { rejected } = setCustomProviders(providers);
    const mine = rejected.find((r) => r.id === id);
    if (mine) return { ok: false, error: mine.why };

    /* 密钥先落盘（`ding init` 向导写的是同一份凭据库） */
    const written = writeSecret(keyRef, input.apiKey.trim());
    if (!written.ok) {
      return { ok: false, error: `密钥写不进去：${written.error ?? "未知原因"}` };
    }

    const nextConfig: CliConfig = { ...config, providers };
    writeConfig(dataDir, nextConfig);
    return { ok: true, provider: toWire(entry) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 删掉一个自定义供应商（内置的不许删）。 */
export function removeCustomProvider(dataDir: string, id: string): { ok: boolean; error?: string } {
  const { config } = readConfig(dataDir);
  const providers = config.providers ?? [];
  if (!providers.some((p) => p.id === id)) return { ok: false, error: `没有这个自定义供应商：${id}` };
  const next = providers.filter((p) => p.id !== id);
  setCustomProviders(next);
  writeConfig(dataDir, { ...config, providers: next });
  return { ok: true };
}

/** 注册通道。 */
export function registerProviderIpc(getDataDir: () => string): void {
  ipcMain.handle(PROVIDER_CHANNEL.listCustom, () => listCustomProviders(getDataDir()));
  ipcMain.handle(PROVIDER_CHANNEL.fetchModels, (_event, input: { baseURL: string; apiKey: string }) =>
    fetchModelsFor({ baseURL: input.baseURL, apiKey: input.apiKey }),
  );
  ipcMain.handle(PROVIDER_CHANNEL.add, (_event, input: ProviderAddInput) =>
    addCustomProvider(getDataDir(), input),
  );
  ipcMain.handle(PROVIDER_CHANNEL.remove, (_event, id: string) => removeCustomProvider(getDataDir(), id));
}

/** 启动时把磁盘里的自定义供应商装进内核（与 CLI 走同一条）。 */
export function loadCustomProvidersIntoMemory(dataDir: string): { rejected: { id: string; why: string }[] } {
  const { config } = readConfig(dataDir);
  return setCustomProviders(config.providers ?? []);
}

void customProviders;
