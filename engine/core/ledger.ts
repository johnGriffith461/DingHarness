import { sumUsage, type StepUsage } from "../../shared/cost";
import type { LogRecord } from "./events";

/**
 * **成本账本**（Phase 3.3）。
 *
 * ## 先立规矩：这里只记 provider 说过的话
 *
 * 账本里的每一个数都来自 provider 在那次请求的响应里**上报的** `usage`。
 * 拿不到就**不记这一条** —— 不按字数估、不按轮数乘、不补一个零。
 *
 * 为什么把这条放在最前面：一个"消耗"数字最坏的失效不是偏小，是**看起来精确**。
 * 界面/终端上一个 `↑10301 ↓854` 没人会怀疑，而它一旦是估出来的，
 * 后面所有"这个任务到底花不花得起"的判断都建在沙子上。
 *
 * （界面上那个**明确标注为估算**的"消耗"数是另一回事，口径在
 * `shared/cost.ts` 的 `fabricatedCost` —— 它从不说自己是 token。）
 *
 * ## 它是怎么算出来的
 *
 * 不新增任何存储：账本**从会话事件流里读**（`done` 事件带着 usage，`request` 事件带着
 * provider/model）。也就是说 —— 会话日志就是账本，两者不可能对不上。
 * 这一点是刻意的：另存一份"用量统计"文件，它迟早会与日志漂移（本项目的老毛病）。
 */

/** 一条入账（一轮 = 一条）。 */
export type LedgerEntry = {
  sessionId: string;
  /** 这一轮的 requestId（同一会话内唯一）。 */
  requestId: string;
  /** 落账时刻（`done` 事件的时间戳）。 */
  at: number;
  provider: string;
  model: string;
  /** provider 上报的用量（**一定存在**：没有它就不入账）。 */
  usage: StepUsage;
};

/** 汇总里的一行。 */
export type LedgerTotal = {
  key: string;
  /** 一句话的标签（会话标题 / 日期 / 模型名）。 */
  label: string;
  /** 入账了几轮。 */
  turns: number;
  /** 合计用量（逐项求和；一个数都没有时 undefined）。 */
  usage?: StepUsage;
  /** 输入 + 输出（provider 没给就 null —— **不编**）。 */
  totalTokens: number | null;
};

/**
 * 从一段会话的记录里算出账本。
 *
 * ⚠️ 一次请求的用量挂在 **`done` 事件**上（`runTurn` 收尾时才拿得到真实 usage）。
 * 于是"这一轮用了多少"要靠 `requestId` 把 `request`（provider/model）与 `done`（usage）
 * 配起来。
 *
 * **配不上也入账**（provider/model 空着，汇总时归到「(未登记模型)」那一行）——
 * 这是一个刻意的取舍：用量是 provider **真的报过**的数，丢掉它会让总数偏小，
 * 而"偏小的账单"比"少一个标签的账单"坏得多。空着的那一格如实空着，不补。
 *
 * @param records 会话记录（按 `seq` 升序）
 * @param sessionId 会话 id（不给就从记录里推不出来，只有 provider/model 有意义）
 * @returns 入账清单（按发生顺序）
 */
export function ledgerOf(records: readonly LogRecord[], sessionId = ""): LedgerEntry[] {
  /** requestId → 那次请求的落账信息（等 done 来配）。 */
  const pending = new Map<string, { at: number; provider: string; model: string }>();
  const out: LedgerEntry[] = [];

  for (const record of records) {
    if (record.type === "request") {
      pending.set(record.requestId, { at: record.at, provider: record.provider, model: record.model });
      continue;
    }
    if (record.type !== "done") continue;
    const usage = (record as { usage?: StepUsage }).usage;
    // 没有上报用量 → 不入账（**不编**）
    if (!usage || (typeof usage.inputTokens !== "number" && typeof usage.outputTokens !== "number")) continue;
    const head = pending.get(record.requestId);
    out.push({
      sessionId,
      requestId: record.requestId,
      at: record.at,
      provider: head?.provider ?? "",
      model: head?.model ?? "",
      usage,
    });
  }
  return out;
}

/** 本地时区的 `YYYY-MM-DD`（按天分组用；**不**用 UTC —— 用户按自己的日期理解"今天花了多少"）。 */
export function localDay(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 把入账清单按某个维度汇总。
 *
 * @param entries 入账清单
 * @param by `session`（会话）/ `day`（天）/ `model`（模型）
 * @param labelOf 会话维度的标签（会话标题在外层拿，这里不猜）
 * @returns 汇总行（按 totalTokens 降序；没有 token 的排在后面）
 */
export function rollup(
  entries: readonly LedgerEntry[],
  by: "session" | "day" | "model",
  labelOf: (key: string) => string = (k) => k,
): LedgerTotal[] {
  const groups = new Map<string, LedgerEntry[]>();
  const keyOf = (e: LedgerEntry): string =>
    by === "session" ? e.sessionId || "(未知会话)" : by === "day" ? localDay(e.at) : e.model || "(未登记模型)";

  for (const entry of entries) {
    const key = keyOf(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const rows: LedgerTotal[] = [];
  for (const [key, list] of groups) {
    const usage = sumUsage(list.map((e) => e.usage));
    const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    rows.push({
      key,
      label: by === "session" ? labelOf(key) : key,
      turns: list.length,
      ...(usage ? { usage } : {}),
      totalTokens: totalTokens > 0 ? totalTokens : null,
    });
  }
  return rows.sort((a, b) => (b.totalTokens ?? -1) - (a.totalTokens ?? -1));
}

/**
 * 一行账目的人话（终端与未来的界面共用一份口径）。
 *
 * ⚠️ 缺失的字段写成 `-`，**不写成 0**：`0` 是"真的没花"，`-` 是"provider 没说"。
 * 这两种情况混起来之后，"这个模型是不是不要钱"就再也分不清了。
 *
 * @param row 汇总行
 * @returns 一句话
 */
export function formatTotal(row: LedgerTotal): string {
  const u = row.usage;
  const input = typeof u?.inputTokens === "number" ? String(u.inputTokens) : "-";
  const output = typeof u?.outputTokens === "number" ? String(u.outputTokens) : "-";
  const cache = typeof u?.cacheReadTokens === "number" ? ` 缓存读 ${u.cacheReadTokens}` : "";
  return `${row.label}：${row.turns} 轮　↑${input} ↓${output}${cache}`;
}
