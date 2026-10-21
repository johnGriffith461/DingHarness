import { envSecret, type KeySource, type SecretPort } from "../ports/secret";
import type { Protocol } from "./models";

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

/*
 * ⚠️ provider id 从"五个字面量的联合类型"改成 `string`（Phase 5.2）：
 * 数量开始涨（官方直连 + 中转 + 自建端点），每加一家都要改联合类型、
 * 改渲染层的下拉、改四处 `as ProviderId`。而它们对代码的意义只有一个：
 * **是个稳定的键**。真正约束行为的是 `protocol`，那个仍然是封闭的词表。
 */
export type ProviderId = string;

export type ProviderDef = {
  id: string;
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
  /**
   * **这一家说哪种协议**（Phase 5.2）。
   *
   * ⚠️ 必填，而且是**线路格式**，不是"哪家公司"。中转站把 claude 用 OpenAI 格式转出来，
   * 那它的协议就是 `openai-compatible` —— 引擎据此选 adapter，不看模型是谁家的。
   */
  protocol: Protocol;
  /**
   * 覆盖模型清单的环境变量名（逗号分隔）。
   *
   * 存在的理由很实际：**模型名会变**，而它是配置不是数据。表里给的是 2026-10-15
   * 从官方/目录里列到的真名；用户手上的账号能开哪些、名字有没有变，
   * 让他们用环境变量覆盖比我们猜要靠谱。
   */
  modelsEnv?: string;
  /** 备注：走本机 / 中转 / 官方直连，以及这个模型清单是哪来的。 */
  note: string;
};

/**
 * **出厂内置的 provider：只有 DeepSeek 一家**（2026-10-21 主人拍板）。
 *
 * 原话：「软件不要给它去内置那些渠道了吧 就留一个 Deepseek 渠道就行，
 * 然后 Deepseek 的渠道信息都给填好了，让用户只用输入 key 就行」。
 *
 * 所以这里只留一条：地址、协议、模型清单全部预填，用户只需要一条 API Key。
 * 其余端点（中转站、Anthropic、Gemini、OpenRouter…）**仍然支持**，但走
 * "添加供应商"由用户自己接 —— 出厂不替用户列一堆他没用过的东西。
 *
 * ## 仍然保留的能力（删的是表项，不是能力）
 *
 * - 三种线路协议（`openai-compatible` / `anthropic` / `google`）照旧，自定义供应商可选；
 * - `<PROVIDER>_MODELS` 覆盖口照旧（DeepSeek 的模型名会变）；
 * - `DEEPSEEK_BASE_URL` 一类的覆盖口在 `baseURLEnv` 里按需加（这家不需要）。
 *
 * ## 模型清单
 *
 * `deepseek-chat` / `deepseek-reasoner` 是官方现役的两个名字（便宜、稳）。
 * 官方还列过 `deepseek-flash`（1M 窗口）与 `deepseek-v4-pro` —— 需要时用
 * `DEEPSEEK_MODELS="deepseek-flash,deepseek-v4-pro"` 覆盖，或去设置里同步模型。
 */
const PROVIDER_TABLE: ProviderDef[] = [
  {
    id: "deepseek",
    label: "DeepSeek 官方",
    protocol: "openai-compatible",
    baseURL: "https://api.deepseek.com/v1",
    keyRef: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    modelsEnv: "DEEPSEEK_MODELS",
    note: "官方直连。地址与模型已填好 —— 只需要一条 API Key",
  },
];

/**
 * **只在验收/评测里出现的通道**（`DING_ACCEPT_PROVIDERS=1` 才注册）。
 *
 * 为什么需要它：批跑要一个"指向本机假服务"的 provider（`STRATA_BASE_URL` 覆盖到
 * `127.0.0.1`），engine 的 eval / bench 也用它走假通道。但它**不该出现在用户面前** ——
 * 主人看到"本地 abliterated"当场就问"是不是还用着你假通道"。
 *
 * id 仍然是 `strata`（大量既有测试与脚本按这个 id 写），但：
 * - 出厂表里**没有**它（用户看不到、选不到）；
 * - 自定义供应商**不能占用**这个 id（避免验收时撞车）。
 */
const ACCEPT_ONLY_TABLE: ProviderDef[] = [
  {
    id: "strata",
    label: "本地测试通道（验收用）",
    protocol: "openai-compatible",
    baseURL: "http://127.0.0.1:8080/v1",
    baseURLEnv: "STRATA_BASE_URL",
    keyRef: "STRATA_API_KEY",
    models: ["deepseek-flash"],
    modelsEnv: "STRATA_MODELS",
    note: "验收/本地假服务专用：正常使用不会出现这一家",
  },
];

/** 验收通道开关（只由验收装置与 eval/bench 打开）。 */
export function acceptProvidersEnabled(): boolean {
  return process.env.DING_ACCEPT_PROVIDERS?.trim() === "1";
}

/** 宿主注入的**自定义 provider**（V6-2j；只由宿主设，内核不读磁盘）。 */
export type CustomProviderInput = {
  id: string;
  label: string;
  baseURL: string;
  protocol: Protocol;
  keyRef: string;
  models: string[];
};

let CUSTOM: ProviderDef[] = [];

/**
 * 设置自定义 provider（宿主在启动时把配置里的那批交进来）。
 *
 * 规矩：
 * - **不能与内置同名**（否则"我配的端点"会悄悄替换掉内置定义，排错时看不到）；
 * - `models` 必须非空（没有模型名的 provider 选不了，等于配了个寂寞）；
 * - 只存进程内，不读磁盘 —— 读盘是宿主的事（CLI 读 config.json，桌面读自己的设置）。
 *
 * @param list 自定义定义
 * @returns 被拒绝的条目（与内置同名/字段不合法），宿主据此提示用户
 */
export function setCustomProviders(list: readonly CustomProviderInput[]): { rejected: { id: string; why: string }[] } {
  const builtinIds = new Set(PROVIDER_TABLE.map((p) => p.id));
  const rejected: { id: string; why: string }[] = [];
  const next: ProviderDef[] = [];
  for (const item of list) {
    const id = String(item.id ?? "").trim();
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
      rejected.push({ id: id || "(空)", why: "id 要小写字母开头、只含小写字母/数字/连字符" });
      continue;
    }
    if (builtinIds.has(id)) {
      rejected.push({ id, why: "与内置 provider 同名（内置定义不能被覆盖）" });
      continue;
    }
    if (!/^https?:\/\//.test(String(item.baseURL ?? ""))) {
      rejected.push({ id, why: "baseURL 必须是 http(s) 地址" });
      continue;
    }
    if (!["openai-compatible", "anthropic", "google"].includes(item.protocol)) {
      rejected.push({ id, why: `不认识的协议：${String(item.protocol)}` });
      continue;
    }
    if (!String(item.keyRef ?? "").trim()) {
      rejected.push({ id, why: "keyRef 必填（密钥的环境变量名/凭据键）" });
      continue;
    }
    const models = (item.models ?? []).map((m) => String(m).trim()).filter(Boolean);
    if (!models.length) {
      rejected.push({ id, why: "至少要给一个模型名（否则选不了）" });
      continue;
    }
    next.push({
      id,
      label: item.label?.trim() || id,
      baseURL: item.baseURL.trim(),
      protocol: item.protocol,
      keyRef: item.keyRef.trim(),
      models,
      note: "自定义端点（宿主配置）",
    });
  }
  CUSTOM = next;
  return { rejected };
}

/** 当前生效的自定义 provider（只读副本）。 */
export function customProviders(): readonly ProviderDef[] {
  return [...CUSTOM];
}

/**
 * 这个 id 是不是**内置** provider（自定义不允许同名覆盖内置）。
 *
 * 用途：目录表要给模型标「数据来源是内置目录还是用户自己接的端点」。
 * 判定直接读表本体 —— 别再在别处抄一份 id 清单（那会随加 provider 腐坏）。
 *
 * @param id provider id
 */
export function isBuiltinProviderId(id: string): boolean {
  /*
   * 验收通道（`strata`）也算"保留 id"：它虽然不出现在出厂表里，
   * 但自定义供应商**不能占用**它 —— 否则验收跑起来会分不清是谁。
   */
  return PROVIDER_TABLE.some((p) => p.id === id) || ACCEPT_ONLY_TABLE.some((p) => p.id === id);
}

/**
 * 全部 provider（**带上环境变量里的 baseURL 覆盖**）。
 *
 * 每次调用都现算：这一层读的是进程环境，而环境是可能变的（宿主切端点、测试指到假服务）。
 *
 * 组成：出厂表（只有 DeepSeek）+ **验收通道（仅 `DING_ACCEPT_PROVIDERS=1` 时）** + 宿主注入的自定义。
 *
 * @returns provider 定义（新的数组，调用方改它不会污染表）
 */
export function allProviders(): ProviderDef[] {
  const base = acceptProvidersEnabled() ? [...PROVIDER_TABLE, ...ACCEPT_ONLY_TABLE] : [...PROVIDER_TABLE];
  return [...base, ...CUSTOM].map((p) => {
    const override = (p.modelsEnv ? process.env[p.modelsEnv]?.trim() : "") || "";
    const models = override
      ? override
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
      : p.models;
    return {
      ...p,
      models: models.length ? models : p.models,
      baseURL: (p.baseURLEnv ? process.env[p.baseURLEnv]?.trim() : "") || p.baseURL,
    };
  });
}

/** 取某一家**实际生效**的协议（不认识这家就按 OpenAI 兼容处理，别把请求发歪）。 */
export function protocolOf(providerId: string): Protocol {
  return getProvider(providerId)?.protocol ?? "openai-compatible";
}

/** 脱敏后的 provider 信息（可安全回传渲染进程）。 */
export type ProviderInfo = {
  id: ProviderId;
  label: string;
  models: string[];
  note: string;
  /** 实际生效的 baseURL（已应用环境变量覆盖）。 */
  baseURL: string;
  /** 是否检测到可用 key（任何来源）。 */
  available: boolean;
  /** 密钥来自哪（M-02）：本应用 / 环境变量 / 旧目录 / 没有。 */
  keySource: KeySource;
  /** **本应用里配过**（= `keySource === "app"`）。首跑与设置页的"已配置"只看这个。 */
  configured: boolean;
  /** 密钥的引用名（只是名字，不是密钥本体；设置里填 key 要用它）。 */
  keyRef: string;
};

/**
 * 列出所有 provider 及其可用性。
 *
 * `secret` 不给 = 只看环境变量（V5-4 4.1 的端口化）：宿主（CLI / 桌面 / 自检）
 * 一律显式传自己的凭据解析，否则"用户在设置里填的 key"会被当成没配。
 *
 * `opts.keySourceOf` 让宿主/测试注入来源判断。**默认实现不碰磁盘**（engine-core 的
 * 边界要求）：只看环境变量与注入的 `secret` 端口 —— 有值但不是环境变量，就按
 * "本应用保存的"算。桌面宿主会显式传 `credentials.keySourceOf`（能区分 `~/.dsh`）。
 *
 * 来源与 `available` 分开算是有意的：环境变量与旧目录里的 key 都"可用"，
 * 但**只有本应用里存的那条算"你配过了"**。
 */
export function listProviders(
  secret: SecretPort = envSecret,
  opts: { keySourceOf?: (ref: string) => KeySource } = {},
): ProviderInfo[] {
  const sourceOf =
    opts.keySourceOf ??
    ((ref: string): KeySource => (process.env[ref]?.trim() ? "env" : secret(ref) !== null ? "app" : "none"));
  return allProviders().map((p) => {
    const keySource = sourceOf(p.keyRef);
    return {
      id: p.id,
      label: p.label,
      models: p.models,
      note: p.note,
      baseURL: p.baseURL,
      /* 2026-10-16：设置页「填 key」要知道写到哪个名字下（只是名字，不是密钥） */
      keyRef: p.keyRef,
      available: secret(p.keyRef) !== null,
      keySource,
      configured: keySource === "app",
    };
  });
}

/** 按 id 取 provider 定义（已应用 baseURL 覆盖）。 */
export function getProvider(id: string): ProviderDef | undefined {
  return allProviders().find((p) => p.id === id);
}

/** 第一个有 key 的 provider（用来自动选默认值）。`secret` 的口径同上。 */
export function firstAvailableProvider(secret: SecretPort = envSecret): ProviderDef | undefined {
  return allProviders().find((p) => secret(p.keyRef) !== null);
}
