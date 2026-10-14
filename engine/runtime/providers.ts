import { hasSecret } from "./credentials";

/**
 * provider 抽象层（PLAN 3.2）。
 *
 * 全部走 OpenAI 兼容协议，所以换 provider 只改这里的表，业务代码不动。
 * 表里的 keyRef 是"环境变量名 / 凭据引用名"，不是密钥本体。
 *
 * ## ⚠️ baseURL 是**惰性**取的（2026-10-14 改）
 *
 * 原来那两处 `process.env.XXX_BASE_URL ?? "默认"` 写在**模块初始化**里，于是
 * "环境变量"其实只在**第一次 import 这个模块时**生效一次：之后改 process.env 没有任何用。
 * 后果有两层：
 *   · 单测里没法把它指到一个假服务上（模块早就被 import 过了）——
 *     而"不连真服务地测主循环"正是最该有的那条测试；
 *   · 宿主在启动后再改配置（切本地端点）会静默不生效。
 *
 * 现在只在**用到时**读一次。改的只是时机，默认值与语义一字不变。
 */

export type ProviderId = "deepseek" | "tokenrhythm" | "apihub" | "qianwen" | "strata";

export type ProviderDef = {
  id: ProviderId;
  /** 展示名。 */
  label: string;
  /** OpenAI 兼容 baseURL（表里给的是**默认值**）。 */
  baseURL: string;
  /** 覆盖 baseURL 的环境变量名（清醒地写在表里，而不是藏在那行的 `??` 里）。 */
  baseURLEnv?: string;
  /** 凭据引用名。 */
  keyRef: string;
  /** 可选模型（第一个是默认）。 */
  models: string[];
  /** 备注：走本机 / 中转 / 官方直连。 */
  note: string;
};

/** 表本体（`baseURL` 是默认值；要拿覆盖后的值请走 `allProviders()` / `getProvider()`）。 */
const PROVIDER_TABLE: ProviderDef[] = [
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
    baseURL: "https://api.apihub.top/v1",
    baseURLEnv: "API_HUB_BASE_URL",
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
    baseURL: "http://127.0.0.1:8080/v1",
    baseURLEnv: "STRATA_BASE_URL",
    keyRef: "STRATA_API_KEY",
    models: ["deepseek-flash"],
    note: "需要自己先起本地服务",
  },
];

/**
 * 全部 provider（**带上环境变量里的 baseURL 覆盖**）。
 *
 * 每次调用都现算：这一层读的是进程环境，而环境是可能变的（宿主切端点、测试指到假服务）。
 *
 * @returns provider 定义（新的数组，调用方改它不会污染表）
 */
export function allProviders(): ProviderDef[] {
  return PROVIDER_TABLE.map((p) => ({
    ...p,
    baseURL: (p.baseURLEnv ? process.env[p.baseURLEnv]?.trim() : "") || p.baseURL,
  }));
}

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
  return allProviders().map((p) => ({
    id: p.id,
    label: p.label,
    models: p.models,
    note: p.note,
    available: hasSecret(p.keyRef),
  }));
}

/** 按 id 取 provider 定义（已应用 baseURL 覆盖）。 */
export function getProvider(id: string): ProviderDef | undefined {
  return allProviders().find((p) => p.id === id);
}

/** 第一个有 key 的 provider（用来自动选默认值）。 */
export function firstAvailableProvider(): ProviderDef | undefined {
  return allProviders().find((p) => hasSecret(p.keyRef));
}
