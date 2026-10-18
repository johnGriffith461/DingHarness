import { KEEP_RECENT_TOKENS } from "../core/context";
import { UNKNOWN_MODEL_BUDGET, describeModel, findModel, isStale } from "./models";

/**
 * **上下文预算策略**（D04，2026-10-18 重写）。
 *
 * 目录表本体在 `engine/runtime/models.ts`（协议、能力、来源、过期）；
 * 这个文件只回答一个问题：**这一轮给历史留多少额度**。
 *
 * ## 为什么重写（产品审计的原话："1M 模型只留 20k"）
 *
 * 上一版的规则是「窗口 × 50%，再封顶 20000」。它有两个问题：
 *
 * 1. **20k 是全局上限**：1M 的模型也只能用 2% 的窗口。用户以为买了大窗口，
 *    实际每轮只发两万 token，长任务必然失忆。
 * 2. **往下也不安全**：50% 不留输出额度，窗口 32k 的模型按 50% 留 16k，
 *    再加上输出就可能顶爆。
 *
 * 现在按成熟 harness 的口径（按窗口推导，默认 `long`）：
 *
 * ```
 * reserve  = min(outputLimit ?? 32_000, 21_000)      // 给输出留的位置
 * buffer   = 13_000                                   // 工具 schema / 系统提示的余量
 * keepLong = max(20_000, W - reserve - buffer)
 * ```
 *
 * 并且**永不越过 `W - reserve`**（见 `keepForWindow`）。三档：
 *
 * | 档位 | 口径 | 1M 窗口 | 200k 窗口 |
 * |---|---|---|---|
 * | `long`（默认） | `max(20k, W - reserve - buffer)` | ~966k | ~166k |
 * | `balanced` | `W × 50%` | 500k | 100k |
 * | `economy` | `50k`（小窗口再被 `W - reserve` 压住） | 50k | 50k |
 *
 * ## 未登记模型仍然走 20k
 *
 * "不知道它的窗口"时，**不能**拿一个估计值去发请求 —— 那会直接打爆。
 * 所以未登记 → 20k，并在界面上标"未登记模型"。
 *
 * ⚠️ 这个 20k 与上面公式里的 20k **不是一个东西**：公式里的是"大窗口的托底"，
 * 这里是"未知模型的保守默认"。两者数值相同是巧合，语义不同（`UNKNOWN_MODEL_BUDGET`）。
 */

/**
 * 保留额度的**绝对下限**（防止"额度小到等于没有"）。
 *
 * ⚠️ 它是"窗口够大时的托底"；窗口小到放不下时会被 `W - reserve` 压下去。
 */
export const KEEP_RECENT_TOKENS_MIN = 2_000;

/** `balanced` 档的窗口比例。 */
export const KEEP_RATIO = 0.5;

/** `economy` 档的固定额度。 */
export const ECONOMY_KEEP_TOKENS = 50_000;

/** 输出预留的**硬上限**（再大的输出上限也只留这么多，余下的窗口给历史）。 */
export const OUTPUT_RESERVE_MAX = 21_000;

/** 不知道模型输出上限时的保守假设（用于 `reserve`）。 */
export const OUTPUT_RESERVE_FALLBACK = 32_000;

/** 工具 schema / 系统提示的余量。 */
export const CONTEXT_BUFFER = 13_000;

/** 上下文预算档位。 */
export const CONTEXT_BUDGET_MODES = ["long", "balanced", "economy"] as const;
export type ContextBudgetMode = (typeof CONTEXT_BUDGET_MODES)[number];

/** 默认档位（按窗口推导）。 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudgetMode = "long";

/**
 * 磁盘/环境里的档位值不可信 → 只认三个词，其余回落到 `long`。
 *
 * @param raw 原始值
 */
export function parseBudgetMode(raw: unknown): ContextBudgetMode {
  return raw === "balanced" || raw === "economy" || raw === "long" ? raw : DEFAULT_CONTEXT_BUDGET;
}

/** 档位的中文说明（CLI/设置页共用一份口径）。 */
export const BUDGET_MODE_LABEL: Record<ContextBudgetMode, string> = {
  long: "长会话（按模型窗口推导，默认）",
  balanced: "均衡（窗口的一半）",
  economy: "省成本（固定 5 万）",
};

/**
 * 查一次预算的结果。
 *
 * ⚠️ `registered: false` 是**一等结果**（不是"没找到就 undefined"）：
 * 调用方必须显式处理"这个模型我们不知道"这件事 —— 要么走保守默认，要么标注出来。
 *
 * `source` 说明窗口是从哪来的（T0 加）：`user` = 用户自己声明的，
 * `catalog` = 仓库登记过的表。界面上这两种要分开显示 ——
 * "你填的" 与 "我们核过的" 可信度不同。
 */
export type BudgetLookup =
  | {
      registered: true;
      contextWindow: number;
      stale: boolean;
      outputLimit?: number;
      source?: "user" | "catalog";
    }
  | { registered: false; contextWindow: number; stale: false };

/**
 * 用户声明的覆盖（T0 模型能力表单）。
 *
 * 存在的理由：`MODEL_CATALOG` 是**我们**核过的表，接一个新中转站的模型时
 * 它里面没有 —— 以前只能走 20k 保守默认，而模型明明是 1M 的。
 * 现在用户可以在「设置 → 模型」里自己声明，声明的东西从这里进预算。
 */
export type BudgetOverride = {
  contextWindow?: number;
  maxOutputTokens?: number;
};

/**
 * 按模型 id 查预算。
 *
 * @param modelId 模型 id
 * @param now 现在（测试里给固定值）
 * @param override 用户声明的窗口/输出（**优先于目录表**）
 */
export function budgetOf(
  modelId: string | undefined,
  now: number = Date.now(),
  override?: BudgetOverride,
): BudgetLookup {
  /*
   * ⚠️ 顺序是契约：**用户声明 > 目录表 > 保守默认**。
   * 反过来会让「我明明填了 1M 还是按 20k 跑」，而用户没有任何办法查明原因。
   */
  if (override?.contextWindow !== undefined && override.contextWindow > 0) {
    return {
      registered: true,
      contextWindow: override.contextWindow,
      stale: false,
      source: "user",
      ...(override.maxOutputTokens === undefined ? {} : { outputLimit: override.maxOutputTokens }),
    };
  }
  const spec = findModel(modelId);
  if (!spec) return { registered: false, contextWindow: UNKNOWN_MODEL_BUDGET.contextWindow, stale: false };
  return {
    registered: true,
    contextWindow: spec.contextWindow,
    stale: isStale(spec, now),
    source: "catalog",
    ...(spec.outputLimit === undefined ? {} : { outputLimit: spec.outputLimit }),
  };
}

/**
 * 输出预留：给模型自己说话留多少。
 *
 * 三个上限取最小：
 * - 模型自己的输出上限（核过才用）；
 * - 全局硬上限 `OUTPUT_RESERVE_MAX`（21k）；
 * - **窗口的四分之一**（小窗口不能用 21k 把历史挤没）。
 *
 * @param contextWindow 窗口
 * @param outputLimit 模型输出上限（可无）
 */
export function outputReserveFor(contextWindow: number, outputLimit?: number): number {
  const wanted = Math.min(outputLimit ?? OUTPUT_RESERVE_FALLBACK, OUTPUT_RESERVE_MAX);
  return Math.max(0, Math.min(wanted, Math.floor(contextWindow / 4)));
}

/**
 * 某个窗口 + 档位能给历史留多少（纯函数，便于单测覆盖五种窗口）。
 *
 * @param contextWindow 窗口
 * @param mode 档位
 * @param outputLimit 模型输出上限（可无）
 */
export function keepForWindow(
  contextWindow: number,
  mode: ContextBudgetMode = DEFAULT_CONTEXT_BUDGET,
  outputLimit?: number,
): number {
  if (contextWindow <= 0) return 0;
  const reserve = outputReserveFor(contextWindow, outputLimit);
  /** 历史 + 输出不能超过窗口；再留一点余量都不行。 */
  const hardCap = Math.max(0, contextWindow - reserve);
  if (mode === "economy") return Math.min(ECONOMY_KEEP_TOKENS, hardCap);
  if (mode === "balanced") return Math.min(Math.floor(contextWindow * KEEP_RATIO), hardCap);
  /*
   * long：托底 20k（窗口够大时），小窗口按窗口的一半托底，
   * 最后仍被 `hardCap` 压住 —— 三层里最小/最大的关系都写在这里，别在别处再抄一遍。
   */
  const floor = Math.min(KEEP_RECENT_TOKENS, Math.floor(contextWindow / 2), hardCap);
  const raw = contextWindow - reserve - CONTEXT_BUFFER;
  return Math.max(0, Math.min(hardCap, Math.max(floor, raw)));
}

/**
 * 这一轮**该给历史留多少额度**。
 *
 * - 登记过：按窗口 + 档位推导（见文件头）；
 * - 未登记：`KEEP_RECENT_TOKENS`（20k）—— **不拿估计值发请求**。
 *
 * @param modelId 模型 id
 * @param now 现在（测试用）
 * @param mode 档位（默认 `long`）
 */
export function keepTokensFor(
  modelId: string | undefined,
  now: number = Date.now(),
  mode: ContextBudgetMode = DEFAULT_CONTEXT_BUDGET,
  override?: BudgetOverride,
): number {
  const found = budgetOf(modelId, now, override);
  if (!found.registered) return KEEP_RECENT_TOKENS;
  return keepForWindow(found.contextWindow, mode, found.outputLimit);
}

/**
 * 给界面/CLI 的一句话（**如实**：登记过没有、来源是什么、过期没有、我们按多少留）。
 *
 * @param modelId 模型 id
 * @param now 现在（测试用）
 * @param mode 档位
 * @param override 用户声明的窗口/输出
 */
export function describeBudget(
  modelId: string | undefined,
  now: number = Date.now(),
  mode: ContextBudgetMode = DEFAULT_CONTEXT_BUDGET,
  override?: BudgetOverride,
): string {
  const found = budgetOf(modelId, now, override);
  if (!found.registered) {
    return `${describeModel(modelId)}；历史按保守默认 ${KEEP_RECENT_TOKENS} token 保留（未登记，不按估计窗口发请求）`;
  }
  const keep = keepTokensFor(modelId, now, mode, override);
  const reserve = outputReserveFor(found.contextWindow, found.outputLimit);
  const source = found.source === "user" ? "（用户声明）" : "";
  return `${describeModel(modelId)}${source}；窗口 ${found.contextWindow} / 输出预留 ${reserve} / 历史 ${keep}（档位 ${mode}：${BUDGET_MODE_LABEL[mode]}）`;
}

/** 一条预算记录的完整说明（`ding models --json` / 设置页用）。 */
export function budgetBreakdown(
  modelId: string | undefined,
  now: number = Date.now(),
  mode: ContextBudgetMode = DEFAULT_CONTEXT_BUDGET,
  override?: BudgetOverride,
): {
  mode: ContextBudgetMode;
  registered: boolean;
  contextWindow: number;
  outputReserve: number;
  keep: number;
  source?: "user" | "catalog";
} {
  const found = budgetOf(modelId, now, override);
  return {
    mode,
    registered: found.registered,
    contextWindow: found.contextWindow,
    outputReserve: found.registered ? outputReserveFor(found.contextWindow, found.outputLimit) : 0,
    keep: keepTokensFor(modelId, now, mode, override),
    ...(found.registered && found.source ? { source: found.source } : {}),
  };
}
