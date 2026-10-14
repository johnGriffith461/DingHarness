import { KEEP_RECENT_TOKENS } from "../core/context";

/**
 * **模型目录表 + 预算**（Phase 1 D4）。
 *
 * ## 这张表是什么，以及它**不是**什么
 *
 * 它是"某个模型能装多少上下文、大概什么价"的一组**人工核实过的数据**，
 * 每一条都带 `source`（哪来的）与 `verifiedAt`（什么时候核的）。
 *
 * ⚠️ 它**不是**一份凭印象写出来的清单。这个项目有一条纪律：拿不到的数据宁可空着、
 * 走保守默认并标注，也不硬编一个像真数据的数字 —— 因为一个"看起来精确"的上限
 * 会让后面所有"这段历史该不该压"的判断都建在沙子上，而那种错**没有任何东西会报**。
 *
 * ## 为什么 default 走的是原来那个数
 *
 * 未登记的模型 → `keepTokens` 用**旧的固定值**（`KEEP_RECENT_TOKENS`），
 * 并在账本/界面上标"未登记模型"。这是刻意的：对未登记的情况，
 * **行为与换代前一模一样**（零漂移），而不是"换了个更大的数、没人知道为什么"。
 * 想让它变更大，正确做法是把那个模型**登记进来**（带来源），不是调默认值。
 *
 * ## 过期
 *
 * 表里的数据有保质期（`STALE_DAYS`）：模型上下限与价格会变，一条两年前的记录
 * 与"没有记录"一样不能用。超过保质期时 `describeBudget()` 会明说"可能过期"——
 * 标注而不是静默沿用，是这张表能被信任的前提。
 */

/** 一条模型记录。 */
export type ModelBudget = {
  /** 模型 id（与 provider 表里的写法一致）。 */
  id: string;
  /** 上下文窗口（**输入+输出的总上限**，token）。 */
  contextWindow: number;
  /** 单价（美元 / 100 万 token）。给不出就不写 —— 不编。 */
  priceIn?: number;
  priceOut?: number;
  /** 命中缓存的读价（有的 provider 会给）。 */
  priceCacheRead?: number;
  /** 数据来源（URL 或"人工核实"注明）。 */
  source: string;
  /** 核实日期（`YYYY-MM-DD`）。 */
  verifiedAt: string;
  /** 备注（例如"兼容模式的取值"）。 */
  note?: string;
};

/** 数据保质期（天）。超过就在界面上标"可能过期"。 */
export const STALE_DAYS = 90;

/**
 * 查一次预算的结果。
 *
 * ⚠️ `registered: false` 是**一等结果**（不是"没找到就 undefined"）：
 * 调用方必须显式处理"这个模型我们不知道"这件事 —— 要么走保守默认，
 * 要么标注出来。给 `undefined` 的话，最自然的写法是 `?.` 一路空过，
 * 于是"不知道"与"知道但没上限"就混在一起了。
 */
export type BudgetLookup =
  | { registered: true; model: ModelBudget; stale: boolean }
  | { registered: false; model?: undefined; stale: false };

/**
 * 目录表。
 *
 * ## 现在为什么只有两条（如实记）
 *
 * 这三件事是连着发生的，值得写下来：
 *
 * 1. 我们 provider 表里默认用的 `deepseek-chat` / `deepseek-reasoner`，
 *    **DeepSeek 官方文档今天已经不再列它们了**（只剩 `deepseek-flash` 与 `deepseek-v4-pro`）。
 *    也就是说那两个模型名"上限是多少"**无从核实** → 它们走保守默认，并标注"未登记模型"。
 * 2. 通义千问那三个（`qwen-plus` / `qwen-max` / `qwen-turbo`）：阿里帮助中心那页抓不到具体数值
 *    → 同样不登记。**猜一个数比不登记坏得多**（见文件头）。
 * 3. models.dev 的聚合表（`https://models.dev/api.json`）确实带 `limit.context`，
 *    但它那一份 deepseek 目录里同样没有 `deepseek-chat`。Phase 5 的 vendor 流程会把它接上，
 *    那时表会长起来 —— 而不是现在靠印象补几条。
 *
 * 所以两条是**当前能核实到的全部**，不是"先随便放两条"。
 */
export const MODEL_CATALOG: readonly ModelBudget[] = [
  {
    id: "deepseek-flash",
    contextWindow: 1_000_000,
    priceIn: 0.15,
    priceOut: 0.6,
    priceCacheRead: 0.003,
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    verifiedAt: "2026-10-14",
    note: "官方标 1M；价格是**离峰价**（峰值翻倍）。同页列出了 deepseek-v4-pro",
  },
  {
    id: "deepseek-v4-pro",
    contextWindow: 1_000_000,
    priceIn: 0.66,
    priceOut: 1.98,
    priceCacheRead: 0.022,
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    verifiedAt: "2026-10-14",
    note: "官方标 1M；离峰价。我们 provider 表里还没这个模型名 —— 先登记，供 Phase 5 的目录用",
  },
];

/** 按模型 id 查。 */
export function budgetOf(modelId: string | undefined, now: number = Date.now()): BudgetLookup {
  if (!modelId) return { registered: false, stale: false };
  const model = MODEL_CATALOG.find((m) => m.id === modelId);
  if (!model) return { registered: false, stale: false };
  return { registered: true, model, stale: isStale(model, now) };
}

/**
 * 这一条过期了没有。
 *
 * @param model 一条记录
 * @param now 现在（测试里给固定值）
 * @returns 是否超过 `STALE_DAYS`
 */
export function isStale(model: ModelBudget, now: number = Date.now()): boolean {
  const verified = Date.parse(`${model.verifiedAt}T00:00:00Z`);
  if (!Number.isFinite(verified)) return true; // 日期都读不懂 → 当作过期（宁可标出来）
  return now - verified > STALE_DAYS * 86_400_000;
}

/**
 * 这一轮**该给历史留多少额度**。
 *
 * 两种情形：
 * - **登记过的模型**：上限的 `KEEP_RATIO`（历史最多占这么多，其余留给
 *   系统提示词、工具 schema 与这一轮的回复）；
 * - **没登记**：`KEEP_RECENT_TOKENS`（换代前那个固定值）——
 *   行为零漂移，并在账本上标"未登记模型"。
 *
 * ⚠️ 返回的数是**我们自己定的额度**，不是"模型的上限"（见 `core/context.ts` 文件头）。
 *
 * @param modelId 模型 id
 * @param now 现在（测试用）
 * @returns 保留额度（token）
 */
export function keepTokensFor(modelId: string | undefined, now: number = Date.now()): number {
  const found = budgetOf(modelId, now);
  if (!found.registered) return KEEP_RECENT_TOKENS;
  const byModel = Math.floor(found.model.contextWindow * KEEP_RATIO);
  return Math.max(KEEP_RECENT_TOKENS_MIN, Math.min(byModel, MAX_KEEP_TOKENS));
}

/**
 * 保留额度的**上限**：`KEEP_RECENT_TOKENS`（换代前那个固定值）。
 *
 * ## 为什么不跟着模型一路放大（这一条是刻意的，别当 bug 改掉）
 *
 * "上限 × 比例"这条规则如果**只**看模型能力，会得到一个很危险的结果：
 * `deepseek-flash` 的上限是 1M，按一半算就是每轮发 **50 万 token 历史**。
 *
 * ⚠️ 每轮都要把历史**重发一遍** —— 上下文额度直接乘在**每一轮的钱**上。
 * 从 2 万涨到 50 万是**单轮成本 ×25**，而且是**静默**发生的：
 * 用户只会看到账单变贵，看不出是这次换代改的。
 * （本项目对"看着有、其实没用"和"悄悄改了行为"这两类都写进过纪律，这是第三类：
 * 悄悄改了**代价**。）
 *
 * 所以这条规则的用法是**双向**的：
 * - **往下**跟着模型走（上限小的模型少留一点，别顶爆）—— 这一半立刻生效；
 * - **往上封顶**在我们自己定的额度上（花钱换连续性是个**决定**，不该由默认值替用户做）。
 *
 * 想留更多历史：把这里调大（Phase 9 会接成用户配置项）。那时它是个**明示**的选择，
 * 而不是一个没人注意到的默认值。
 */
export const MAX_KEEP_TOKENS = KEEP_RECENT_TOKENS;

/**
 * 历史最多占上限的比例。
 *
 * 取值理由：历史是**被动增长**的那一块（工具输出一次能塞几千 token），
 * 而系统提示词与工具 schema 是**有界**的、回复是**一段**的。
 * 给历史一半、其余留一半，是"够几轮连续对话"与"顶不爆"之间的折中。
 */
export const KEEP_RATIO = 0.5;

/**
 * 保留额度的下限（2000）。
 *
 * 它的作用只有一个：**防止"额度小到等于没有"**（比如上限 3K 的模型按一半算是 1.5K，
 * 那这段历史基本不剩什么了）。它**不是质量保证** —— 真正的兜底是
 * `planContext` 的规矩"最后一条永远留下"（用户刚说的那句话，丢掉这轮就没意义了）。
 *
 * ⚠️ 取 2000 而不是更大：下限如果跟 `KEEP_RECENT_TOKENS` 一样大（20000），
 * 就会把"上限小的模型少留一点"这一半**整个盖掉** ——
 * 上限 8K 的模型会照样留 8K 历史，然后每轮顶爆。第一版就是 8000，测试当场逮到。
 */
export const KEEP_RECENT_TOKENS_MIN = 2000;

/**
 * 给界面/CLI 的一句话（**如实**：登记过没有、来源是什么、过期没有）。
 *
 * @param modelId 模型 id
 * @param now 现在（测试用）
 * @returns 一句话
 */
export function describeBudget(modelId: string | undefined, now: number = Date.now()): string {
  const found = budgetOf(modelId, now);
  if (!found.registered) {
    return `${modelId || "(未指定模型)"}：未登记模型 —— 上下文额度按保守默认（${KEEP_RECENT_TOKENS}），用量照实入账`;
  }
  const m = found.model;
  const price =
    typeof m.priceIn === "number" && typeof m.priceOut === "number" ? `，$${m.priceIn}/$${m.priceOut} 每百万 token` : "，单价未记录";
  const fresh = found.stale ? `⚠️ 数据可能过期（${m.verifiedAt} 核实）` : `（${m.verifiedAt} 核实）`;
  return `${m.id}：上下文 ${m.contextWindow}${price}${fresh}；我们按 ${keepTokensFor(modelId, now)} token 保留历史（封顶 ${MAX_KEEP_TOKENS}）。来源 ${m.source}`;
}
