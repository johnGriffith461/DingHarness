import { matchCatalogEntry } from "./modelCatalogSnapshot";
import type { CatalogEntry } from "./modelSnapshot";

export { canonicalModelId } from "./modelSnapshot";

/**
 * **模型能力的四级来源**（M-07）。
 *
 * 目标：M-04 的"选中模型后自动带出窗口/输出"真的有东西可填，而不是永远落到"未登记"。
 *
 * 优先级（高 → 低）：`user`（用户显式声明）→ `endpoint`（`/models` 自报）→
 * `catalog`（仓库里的目录快照）→ `default`（200k / 32k，**并明确标记**）。
 *
 * ## 三条口径
 *
 * 1. **逐字段解析**：窗口可能来自目录、输出上限可能来自端点 —— 不让一个来源把另一个的更准数据盖掉。
 * 2. **`source` 说的是窗口那一项的来源**（界面上那行小字就是给窗口看的）；
 *    其余字段各自的来源在 `sources` 里，谁想知道都能查。
 * 3. **匹配不上一律 `default` + 标记**，绝不拿"看起来合理"的数字冒充事实。
 *
 * 目录数据来自 `engine/runtime/models.generated.ts`（由 `scripts/vendor-models.mjs`
 * 从 `models.snapshot.json` 生成）。**没有另建第二份快照** —— 那会让两处数字漂。
 */

export type CapabilitySource = "catalog" | "endpoint" | "user" | "default";

/** 端点 `/models` 自报的能力（只有对方给了才有）。 */
export type EndpointModelInfo = {
  contextWindow?: number;
  maxOutput?: number;
  inputModalities?: string[];
  reasoning?: boolean;
};

/** 用户显式声明（`models.json` 的 exact 规则摊平后的那几项）。 */
export type DeclaredCapability = {
  contextWindow?: number;
  maxOutput?: number;
  inputModalities?: string[];
  reasoning?: boolean;
  /** 有推理档位也算"这个模型支持思考"。 */
  reasoningLevels?: string[];
};

export type ResolvedCapability = {
  contextWindow: number;
  maxOutput: number;
  inputModalities: string[];
  reasoning: boolean;
  /** 目录/端点说它支不支持工具调用（目录没写时按 false，不猜）。 */
  toolCall: boolean;
  /** 窗口那一项的来源（界面那行小字）。 */
  source: CapabilitySource;
  /** 字段级来源（排障/单测用）。 */
  sources: {
    contextWindow: CapabilitySource;
    maxOutput: CapabilitySource;
    inputModalities: CapabilitySource;
    reasoning: CapabilitySource;
  };
  /** 目录命中了哪一条（没有则 undefined）。 */
  catalogMatch?: CatalogEntry;
};

/** 没有登记时的**展示用**默认（与 OpenCode 的默认一致，且标记为 default）。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_OUTPUT = 32_000;

/** 名字归一：见 `modelSnapshot.ts`（两处共用一份实现）。 */

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function modalitiesOf(spec: CatalogEntry): string[] {
  return spec.inputModalities.length ? [...spec.inputModalities] : ["text"];
}

/** 解析一条模型的能力。 */
export function resolveCapability(input: {
  providerId: string;
  modelId: string;
  fetched?: EndpointModelInfo;
  declared?: DeclaredCapability;
}): ResolvedCapability {
  const declared = input.declared ?? {};
  const fetched = input.fetched ?? {};
  const catalog = matchCatalogEntry(input.providerId, input.modelId);

  const declaredReasoning =
    typeof declared.reasoning === "boolean"
      ? declared.reasoning
      : declared.reasoningLevels && declared.reasoningLevels.length > 0
        ? true
        : undefined;

  const contextFromUser = positive(declared.contextWindow);
  const contextFromEndpoint = positive(fetched.contextWindow);
  const contextFromCatalog = positive(catalog?.contextWindow);

  const contextWindow = contextFromUser ?? contextFromEndpoint ?? contextFromCatalog ?? DEFAULT_CONTEXT_WINDOW;
  /*
   * 注意 `??` 的顺序：0 会被 positive() 挡掉，所以这里每一个都是"真的给了"。
   * 目录条目的 maxOutput 可能缺（不编），缺了才往下落到 endpoint / 默认。
   */
  const maxOutput =
    positive(declared.maxOutput) ?? positive(fetched.maxOutput) ?? positive(catalog?.maxOutput) ?? DEFAULT_MAX_OUTPUT;

  const userModalities = declared.inputModalities?.filter(Boolean);
  const endpointModalities = fetched.inputModalities?.filter(Boolean);
  const catalogModalities = catalog ? modalitiesOf(catalog) : undefined;
  const inputModalities = userModalities?.length
    ? userModalities
    : endpointModalities?.length
      ? endpointModalities
      : (catalogModalities ?? ["text"]);

  const reasoning =
    declaredReasoning ?? (typeof fetched.reasoning === "boolean" ? fetched.reasoning : undefined) ??
    catalog?.reasoning ?? false;

  const sources = {
    contextWindow: contextFromUser
      ? ("user" as const)
      : contextFromEndpoint
        ? ("endpoint" as const)
        : contextFromCatalog
          ? ("catalog" as const)
          : ("default" as const),
    maxOutput:
      positive(declared.maxOutput) !== undefined
        ? ("user" as const)
        : positive(fetched.maxOutput) !== undefined
          ? ("endpoint" as const)
          : positive(catalog?.maxOutput) !== undefined
            ? ("catalog" as const)
            : ("default" as const),
    inputModalities: userModalities?.length
      ? ("user" as const)
      : endpointModalities?.length
        ? ("endpoint" as const)
        : catalogModalities
          ? ("catalog" as const)
          : ("default" as const),
    reasoning:
      declaredReasoning !== undefined
        ? ("user" as const)
        : typeof fetched.reasoning === "boolean"
          ? ("endpoint" as const)
          : catalog
            ? ("catalog" as const)
            : ("default" as const),
  };

  return {
    contextWindow,
    maxOutput,
    inputModalities,
    reasoning,
    toolCall: catalog?.toolCall === true,
    source: sources.contextWindow,
    sources,
    ...(catalog ? { catalogMatch: catalog } : {}),
  };
}

/** 界面上那行小字（来源可见，用户才知道该不该信）。 */
export function sourceLabel(source: CapabilitySource, opts: { edited?: boolean } = {}): string {
  if (opts.edited) return "已手动修改";
  switch (source) {
    case "user":
      return "来自你的声明";
    case "endpoint":
      return "来自端点返回";
    case "catalog":
      return "来自模型目录（models.dev）";
    default:
      return "默认值（未登记模型，请核对）";
  }
}
