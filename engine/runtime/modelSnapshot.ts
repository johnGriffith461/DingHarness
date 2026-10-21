import { MODEL_CATALOG } from "./models";

/**
 * **模型目录快照**（M-07 的 catalog 层）。
 *
 * ## 数据从哪来（如实记，2026-10-21）
 *
 * 方案原意是拉 `https://models.dev/api.json`。实测两次都在 3.2MB 左右被对端
 * **截断**（与仓库里 2026-10-15 记的那次同一个症状），拿不到完整 JSON。
 * 所以这一层用的是 **OpenRouter 的公开 `/api/v1/models`** —— 它自报的字段
 * 正好是我们要的四项（`context_length` / `top_provider.max_completion_tokens` /
 * `architecture.input_modalities` / `supported_parameters`），而仓库里
 * `models.snapshot.json` 本来就是 OpenRouter 目录快照，口径一致。
 *
 * 生成：`pnpm build:model-snapshot`（`scripts/build-model-snapshot.ts`）。
 * 产物 `engine/runtime/data/models.snapshot.json` **要提交**（离线可用、可复核）。
 *
 * ## 与 `models.ts` 的关系
 *
 * `models.ts` 里的是**我们自己核过**的条目（一手官方文档）。合并时它**在前**，
 * 同名以它为准 —— 手核数据比聚合目录可信。快照只补它没有的模型与字段。
 */

/** 快照文件里的一条（字段尽量贴 models.dev 的形状，方便以后换源）。 */
export type SnapshotModel = {
  id: string;
  provider: string;
  canonical_model_id: string;
  name: string;
  limit: { context: number; output?: number };
  modalities: { input: string[]; output: string[] };
  tool_call: boolean;
  reasoning: boolean;
  reasoning_options?: { supported_efforts?: string[]; default_effort?: string };
  cost?: { in?: number; out?: number };
};

/** 解析后用于匹配的扁平条目（`models.ts` 与快照归一成同一种）。 */
export type CatalogEntry = {
  id: string;
  provider: string;
  canonicalId: string;
  name: string;
  contextWindow: number;
  maxOutput?: number;
  inputModalities: string[];
  toolCall: boolean;
  reasoning: boolean;
  /** 来源标记：手核 / 快照。 */
  from: "hand" | "snapshot";
};

/**
 * 从 OpenRouter `/api/v1/models` 的响应裁剪出快照（**纯函数**，脚本与单测共用）。
 *
 * 只留我们要的字段：无关的描述/链接/排行榜不进仓库。
 * 没有 `id` 的条目直接丢（认不出名字的东西没法匹配）。
 */
export function trimOpenRouterModels(raw: unknown): SnapshotModel[] {
  const data =
    raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)
      ? ((raw as { data: unknown[] }).data as unknown[])
      : Array.isArray(raw)
        ? raw
        : [];
  const out: SnapshotModel[] = [];
  const seen = new Set<string>();

  const num = (v: unknown): number | undefined => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };
  const perMillion = (v: unknown): number | undefined => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Number((n * 1_000_000).toFixed(4)) : undefined;
  };

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const top = o.top_provider && typeof o.top_provider === "object" ? (o.top_provider as Record<string, unknown>) : {};
    const arch = o.architecture && typeof o.architecture === "object" ? (o.architecture as Record<string, unknown>) : {};
    const pricing = o.pricing && typeof o.pricing === "object" ? (o.pricing as Record<string, unknown>) : {};
    const params = Array.isArray(o.supported_parameters)
      ? o.supported_parameters.filter((p): p is string => typeof p === "string")
      : [];

    const context = num(o.context_length) ?? num(top.context_length);
    if (!context) continue;

    const inputModalities = (Array.isArray(arch.input_modalities) ? arch.input_modalities : ["text"])
      .filter((m): m is string => typeof m === "string")
      .map((m) => (m === "file" ? "pdf" : m));
    const outputModalities = (Array.isArray(arch.output_modalities) ? arch.output_modalities : ["text"]).filter(
      (m): m is string => typeof m === "string",
    );

    const reasoning =
      params.some((p) => /reasoning/i.test(p)) ||
      (o.reasoning !== null && typeof o.reasoning === "object");

    const efforts =
      o.reasoning && typeof o.reasoning === "object"
        ? (o.reasoning as Record<string, unknown>).supported_efforts
        : undefined;
    const defaultEffort =
      o.reasoning && typeof o.reasoning === "object"
        ? (o.reasoning as Record<string, unknown>).default_effort
        : undefined;

    const vendor = id.split("/")[0] ?? "openrouter";
    const canonical = id.split("/").pop() ?? id;

    out.push({
      id,
      provider: vendor,
      canonical_model_id: canonical,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : id,
      limit: {
        context,
        ...(num(top.max_completion_tokens) === undefined ? {} : { output: num(top.max_completion_tokens) }),
      },
      modalities: {
        input: [...new Set(inputModalities)],
        output: outputModalities.length ? outputModalities : ["text"],
      },
      tool_call: params.includes("tools") || params.includes("tool_choice"),
      reasoning,
      ...(Array.isArray(efforts) && efforts.length
        ? {
            reasoning_options: {
              supported_efforts: efforts.filter((e): e is string => typeof e === "string"),
              ...(typeof defaultEffort === "string" ? { default_effort: defaultEffort } : {}),
            },
          }
        : {}),
      ...(perMillion(pricing.prompt) !== undefined || perMillion(pricing.completion) !== undefined
        ? {
            cost: {
              ...(perMillion(pricing.prompt) === undefined ? {} : { in: perMillion(pricing.prompt) }),
              ...(perMillion(pricing.completion) === undefined ? {} : { out: perMillion(pricing.completion) }),
            },
          }
        : {}),
    });
  }
  return out;
}

/** 名字归一：去 vendor 前缀、小写、点/下划线/空格统一成连字符。 */
export function canonicalModelId(id: string): string {
  const tail = String(id ?? "").trim().split("/").pop() ?? "";
  return tail.trim().toLowerCase().replace(/[._\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** 快照文件里的一批条目（构建期注入；`modelCatalogSnapshot.ts` 读 JSON）。 */
export function snapshotEntries(models: readonly SnapshotModel[]): CatalogEntry[] {
  return models.map((m) => ({
    id: m.id,
    provider: m.provider,
    canonicalId: canonicalModelId(m.canonical_model_id || m.id),
    name: m.name,
    contextWindow: m.limit.context,
    ...(m.limit.output === undefined ? {} : { maxOutput: m.limit.output }),
    inputModalities: m.modalities?.input?.length ? [...m.modalities.input] : ["text"],
    toolCall: m.tool_call === true,
    reasoning: m.reasoning === true,
    from: "snapshot" as const,
  }));
}

/** `models.ts` 里手动核过的条目 → 同一种扁平结构（手核优先）。 */
export function handEntries(): CatalogEntry[] {
  return MODEL_CATALOG.map((m) => ({
    id: m.id,
    provider: m.provider,
    canonicalId: canonicalModelId(m.id),
    name: m.id,
    contextWindow: m.contextWindow,
    ...(m.outputLimit === undefined ? {} : { maxOutput: m.outputLimit }),
    inputModalities: m.modalities?.length ? [...m.modalities] : m.capabilities.attachment ? ["text", "image"] : ["text"],
    toolCall: m.capabilities.toolCall === true,
    reasoning: m.capabilities.reasoning === true,
    from: "hand" as const,
  }));
}

/**
 * 手核在前、快照在后（同名同 provider 时先命中的是手核那条）。
 *
 * 但**字段级合并**：手核条目缺 `outputLimit`（历史数据里确实没有）时，
 * 用快照里的 `maxOutput` 补上 —— 否则"目录命中了"却带不出输出上限，
 * M-04 的预填会莫名其妙落到默认值。
 */
export function mergedCatalog(models: readonly SnapshotModel[]): CatalogEntry[] {
  const snaps = snapshotEntries(models);
  const used = new Set<string>();
  const hands = handEntries().map((h) => {
    const partner = snaps.find((s) => !used.has(s.id) && s.provider === h.provider && s.canonicalId === h.canonicalId);
    if (!partner) return h;
    used.add(partner.id);
    return {
      ...h,
      ...(h.maxOutput === undefined && partner.maxOutput !== undefined ? { maxOutput: partner.maxOutput } : {}),
      inputModalities:
        h.inputModalities.length > 1 || partner.inputModalities.length <= 1
          ? h.inputModalities
          : [...partner.inputModalities],
      reasoning: h.reasoning || partner.reasoning,
      toolCall: h.toolCall || partner.toolCall,
    };
  });
  return [...hands, ...snaps.filter((s) => !used.has(s.id))];
}
