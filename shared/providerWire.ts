/**
 * **自定义供应商的 IPC 形状**（T0 桌面「新供应商」）。
 *
 * 用户在设置里填 Base URL + API 格式 + API Key，拉取模型清单，勾几个就能用。
 * 这条链路与 CLI 的 `ding providers add` 是**同一份配置**（`config.json` 的 `providers`）。
 */

/**
 * API 格式（三选一）——用户看到的就是这三种。
 *
 * ⚠️ 与内核的 `Protocol` 不是一一对应：内核还多一个 `google`（Gemini 原生），
 * 那是内置供应商用的；新供应商这张表单只列这三种，因为它们是"通用端点"的三种形态。
 */
export type ProviderFormatWire = "anthropic" | "openai-compatible" | "openai-responses";

export type CustomProviderWire = {
  id: string;
  label: string;
  baseURL: string;
  protocol: ProviderFormatWire;
  models: string[];
  /** 密钥引用名（凭据文件里 `refs:` 下那个键）。 */
  keyRef: string;
};

export type ProviderAddInput = {
  /** 显示名；内部 id 由它派生（用户不用管 id）。 */
  label: string;
  baseURL: string;
  format: ProviderFormatWire;
  /** 明文密钥 —— 只在这次调用里出现，主进程收到就写进凭据库，不回传。 */
  apiKey: string;
  models: string[];
};

export type ProviderAddResult =
  | { ok: true; provider: CustomProviderWire }
  | { ok: false; error: string };

/** 桌面侧要用的那一组通道。 */
export type ProviderBridge = {
  /** 列出用户自己加的供应商。 */
  listCustom: () => Promise<CustomProviderWire[]>;
  /** 拉取某组「地址 + 密钥」的模型清单（不落盘，只回名字）。 */
  fetchModels: (input: { baseURL: string; apiKey: string }) => Promise<{
    ok: boolean;
    models?: string[];
    error?: string;
  }>;
  /** 保存一个新供应商（同时把密钥写进凭据库）。 */
  add: (input: ProviderAddInput) => Promise<ProviderAddResult>;
  /** 删掉一个自定义供应商（不动内置的）。 */
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
};
