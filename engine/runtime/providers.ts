import { hasSecret } from "./credentials";

/**
 * provider 抽象层（PLAN 3.2）。
 *
 * 全部走 OpenAI 兼容协议，所以换 provider 只改这里的表，业务代码不动。
 * 表里的 keyRef 是"环境变量名 / 凭据引用名"，不是密钥本体。
 */

export type ProviderId = "deepseek" | "tokenrhythm" | "apihub" | "qianwen" | "strata";

export type ProviderDef = {
  id: ProviderId;
  /** 展示名。 */
  label: string;
  /** OpenAI 兼容 baseURL。 */
  baseURL: string;
  /** 凭据引用名。 */
  keyRef: string;
  /** 可选模型（第一个是默认）。 */
  models: string[];
  /** 备注：走本机 / 中转 / 官方直连。 */
  note: string;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "deepseek",
    label: "DeepSeek 官方",
    baseURL: "https://api.deepseek.com/v1",
    keyRef: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "官方直连，最稳",
  },
  {
    id: "tokenrhythm",
    label: "tokenrhythm 中转",
    baseURL: "https://tokenrhythm.studio/v1",
    keyRef: "A_API_KEY",
    models: ["deepseek-flash", "deepseek-chat", "gpt-4o-mini"],
    note: "中转，便宜",
  },
  {
    id: "apihub",
    label: "API_HUB 中转",
    baseURL: process.env.API_HUB_BASE_URL ?? "https://api.apihub.top/v1",
    keyRef: "API_HUB_API_KEY",
    models: ["deepseek-chat", "deepseek-v3", "gpt-4o-mini", "claude-3-5-sonnet"],
    note: "多模型中转（baseURL 可用 API_HUB_BASE_URL 覆盖）",
  },
  {
    id: "qianwen",
    label: "通义千问",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyRef: "QIANWEN_API_KEY",
    models: ["qwen-plus", "qwen-max", "qwen-turbo"],
    note: "阿里兼容模式",
  },
  {
    id: "strata",
    label: "本地 abliterated",
    baseURL: process.env.STRATA_BASE_URL ?? "http://127.0.0.1:8080/v1",
    keyRef: "STRATA_API_KEY",
    models: ["deepseek-flash"],
    note: "需要自己先起本地服务",
  },
];

/** 脱敏后的 provider 信息（可安全回传渲染进程）。 */
export type ProviderInfo = {
  id: ProviderId;
  label: string;
  models: string[];
  note: string;
  /** 是否检测到可用 key。 */
  available: boolean;
};

/** 列出所有 provider 及其可用性。 */
export function listProviders(): ProviderInfo[] {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    models: p.models,
    note: p.note,
    available: hasSecret(p.keyRef),
  }));
}

/** 按 id 取 provider 定义。 */
export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** 第一个有 key 的 provider（用来自动选默认值）。 */
export function firstAvailableProvider(): ProviderDef | undefined {
  return PROVIDERS.find((p) => hasSecret(p.keyRef));
}
