import { keepTokensFor } from "./budget";
import { UNKNOWN_MODEL_BUDGET, findModel, isStale, type ModelSpec } from "./models";

/**
 * **模型能力表**（D03，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 产品审计的原话："28 个模型、7 个未登记；28 行重复『20k』；无能力/价格"。
 * 用户打开 `ding models` 看到的是一串 provider → 模型名的重复清单，
 * 每个未登记模型都重复同一句"上下文按保守默认 20000"，而**能干什么、多少钱**一个字没有。
 *
 * 这个文件把「目录里的数据」翻译成「用户要做的决定」：
 *
 * - 每个模型一条**能力记录**（窗口、输出上限、价格、缓存价、模态、思考、工具）；
 * - 按用途**分组**：推荐 / 编码 / 长上下文 / 便宜 / 读图 / 未登记；
 * - 未登记模型**单独关起来**（不再混进推荐），并如实说"这是保守估计，不是真实窗口"。
 *
 * ## 两条不许破的口径
 *
 * 1. **不许编数**：目录里没写 `outputLimit` 就保持 `undefined`，界面显示"未记录"，
 *    不拿一个"看起来合理"的数字填空。价格同理。
 * 2. **未登记 ≠ 不知道任何事**：`contextWindow` 给 200k 是**保守估计**（UI 标 `估计`），
 *    但预算仍只按 20k 保留（见 `budget.ts`）—— 估计可以拿来展示，不能拿来花用户的钱。
 */

/** 一条模型能力记录（字段与方案 D03 对齐）。 */
export type ModelCapability = {
  id: string;
  provider: string;
  label: string;
  /** 上下文窗口。未登记时是**保守估计**（见 `estimated`）。 */
  contextWindow: number;
  /** 输出上限。目录里没有就 `undefined` —— 不编。 */
  outputLimit?: number;
  priceIn?: number;
  priceOut?: number;
  cacheRead?: number;
  cacheWrite?: number;
  modalities?: Array<"text" | "image" | "audio" | "video">;
  reasoning?: boolean;
  toolCalling?: boolean;
  /** 目录里有这条（有来源与核实日期）没有。 */
  registered: boolean;
  /** `contextWindow` 是估计值（只有未登记模型会为 true）。 */
  estimated: boolean;
  /** 数据来源：内置目录 / 用户自定义 provider / 从 provider 清单里发现的。 */
  source: "builtin" | "custom" | "discovered";
  /** 数据核实日期（仅登记过的模型有）。 */
  verifiedAt?: string;
  /** 数据可能过期（仅登记过的模型会为 true）。 */
  stale?: boolean;
};

/**
 * 未登记模型的**展示用**保守估计。
 *
 * ⚠️ 它**不是**任何模型的真实窗口，也**不参与预算**（预算对未登记模型仍按 20k 保留）。
 * 给 200k 是因为 2026 年主流模型的窗口都在这附近：拿它做"大概能装多少"的展示，
 * 比显示"20k"更接近事实；但拿它去发请求就会超 —— 所以 `budget.ts` 不认它。
 */
export const UNKNOWN_CONTEXT_ESTIMATE = 200_000;

/** 分组（顺序即 `ding models` 的展示顺序）。 */
export const MODEL_GROUPS = ["推荐", "编码", "长上下文", "便宜", "读图", "未登记"] as const;
export type ModelGroup = (typeof MODEL_GROUPS)[number];

/**
 * 「推荐」是**有理由的**清单，不是按价格排序。
 *
 * 每条理由写在后面；新增一条要能回答"它凭什么进推荐"。
 */
const RECOMMENDED: ReadonlyArray<{ id: string; why: string }> = [
  { id: "deepseek-flash", why: "1M 窗口 + 便宜 + 支持工具/思考，日常默认" },
  { id: "deepseek-chat", why: "便宜、稳，工具调用正常" },
  { id: "gpt-4o-mini", why: "便宜、快，适合轻任务" },
  { id: "claude-sonnet-4-5", why: "长上下文与写作/代码质量稳" },
];

/** 「编码」清单（有工具调用 + 推理，且社区反馈适合写代码）。 */
const CODING = ["deepseek-flash", "deepseek-v4-pro", "claude-sonnet-4-5", "claude-opus-4-5", "gpt-5.4-mini"] as const;

/** 长上下文门槛（token）。 */
export const LONG_CONTEXT_THRESHOLD = 200_000;

/** 便宜门槛（输入价，美元 / 百万 token）。 */
export const CHEAP_PRICE_IN = 0.3;

/**
 * 查一条模型能力。
 *
 * @param id 模型 id
 * @param opts `provider` 用于补全未登记记录（provider 清单里的模型名）；
 *             `source` 让宿主标出"这是自定义 provider"
 * @param now 现在（测试用）
 */
export function capabilityOf(
  id: string,
  opts: { provider?: string; source?: ModelCapability["source"]; now?: number } = {},
): ModelCapability {
  const spec = findModel(id);
  if (!spec) {
    return {
      id,
      provider: opts.provider ?? "unknown",
      label: id,
      contextWindow: UNKNOWN_CONTEXT_ESTIMATE,
      modalities: ["text"],
      registered: false,
      estimated: true,
      source: opts.source ?? "discovered",
    };
  }
  return fromSpec(spec, opts.source ?? "builtin", opts.now);
}

/** 目录条目 → 能力记录。 */
function fromSpec(spec: ModelSpec, source: ModelCapability["source"], now?: number): ModelCapability {
  const modalities: ModelCapability["modalities"] =
    spec.modalities && spec.modalities.length > 0
      ? [...spec.modalities]
      : spec.capabilities.attachment
        ? ["text", "image"]
        : ["text"];
  return {
    id: spec.id,
    provider: spec.provider,
    label: spec.id,
    contextWindow: spec.contextWindow,
    ...(spec.outputLimit === undefined ? {} : { outputLimit: spec.outputLimit }),
    ...(spec.priceIn === undefined ? {} : { priceIn: spec.priceIn }),
    ...(spec.priceOut === undefined ? {} : { priceOut: spec.priceOut }),
    ...(spec.priceCacheRead === undefined ? {} : { cacheRead: spec.priceCacheRead }),
    ...(spec.priceCacheWrite === undefined ? {} : { cacheWrite: spec.priceCacheWrite }),
    modalities,
    reasoning: spec.capabilities.reasoning === true,
    toolCalling: spec.capabilities.toolCall === true,
    registered: true,
    estimated: false,
    source,
    verifiedAt: spec.verifiedAt,
    stale: isStale(spec, now),
  };
}

/**
 * 一条能力记录属于哪些分组。
 *
 * 未登记模型**只**进「未登记」—— 这是审计那条"7 个未登记不再混在推荐里"的落点。
 *
 * @param cap 能力记录
 */
export function groupsOf(cap: ModelCapability): ModelGroup[] {
  if (!cap.registered) return ["未登记"];
  const groups: ModelGroup[] = [];
  if (RECOMMENDED.some((r) => r.id === cap.id)) groups.push("推荐");
  if ((CODING as readonly string[]).includes(cap.id)) groups.push("编码");
  if (cap.contextWindow >= LONG_CONTEXT_THRESHOLD) groups.push("长上下文");
  if (typeof cap.priceIn === "number" && cap.priceIn <= CHEAP_PRICE_IN) groups.push("便宜");
  if (cap.modalities?.includes("image")) groups.push("读图");
  return groups;
}

/** 推荐理由（给 `ding models` 的推荐组用；不在推荐里就 `undefined`）。 */
export function recommendReason(id: string): string | undefined {
  return RECOMMENDED.find((r) => r.id === id)?.why;
}

/** 把一批模型 id 按分组排好（组内保持输入顺序；空组不出现）。 */
export function groupCatalog(caps: readonly ModelCapability[]): Array<{ group: ModelGroup; items: ModelCapability[] }> {
  return MODEL_GROUPS.map((group) => ({
    group,
    items: caps.filter((cap) => groupsOf(cap).includes(group)),
  })).filter((g) => g.items.length > 0);
}

/** 数字加千分位（界面/CLI 都用这一个口径，别一边 1000000 一边 1,000,000）。 */
export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** 价格（$/百万 token）；未知就说未知，不显示 $0。 */
export function formatPrice(price: number | undefined): string {
  return typeof price === "number" ? `$${price.toFixed(price < 1 ? 3 : 2)}` : "未知";
}

/**
 * 给 CLI / 界面的一句话（如实：登记没有、窗口是估计还是实测、按多少保留、能不能读图）。
 *
 * @param cap 能力记录
 * @param now 现在（测试用）
 */
export function describeCapability(cap: ModelCapability, now?: number): string {
  const window = `${formatTokens(cap.contextWindow)}${cap.estimated ? "（估计）" : ""}`;
  const keep = formatTokens(keepTokensFor(cap.id, now));
  const price =
    cap.priceIn === undefined && cap.priceOut === undefined
      ? "价格未记录"
      : `${formatPrice(cap.priceIn)} → ${formatPrice(cap.priceOut)} 每百万 token`;
  const caps = [
    cap.toolCalling ? "工具" : "",
    cap.reasoning ? "思考" : "",
    cap.modalities?.includes("image") ? "读图" : "",
    cap.modalities?.includes("audio") ? "音频" : "",
    cap.modalities?.includes("video") ? "视频" : "",
  ]
    .filter(Boolean)
    .join("+");
  const flags = [
    cap.registered ? "" : "未登记",
    cap.stale ? "数据可能过期" : "",
    cap.outputLimit === undefined ? "" : `输出上限 ${formatTokens(cap.outputLimit)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${cap.id}：窗口 ${window} / 历史 ${keep}；${price}${caps ? `；支持 ${caps}` : ""}${flags ? `；${flags}` : ""}`;
}

/** 未登记模型的保守默认（与 `models.ts` 同一份，别在两处各写一个 20000）。 */
export const UNKNOWN_KEEP_HINT = UNKNOWN_MODEL_BUDGET.contextWindow;
