/**
 * 「消耗」这个数的**唯一**说法（C5）。
 *
 * ## 必须先说清的一件事：本体那个数不是 token
 *
 * 实机读数记在 `docs/HANDOFF.md:1695`：
 *
 * > | 额度消耗 | 「消耗 0.48」——**按额度计量，不是 token** |
 *
 * "额度"是本体账号体系里的东西。**本机版没有额度体系**，所以那个数**算不出来**，
 * 也不该假装算得出来。于是这里的口径是：
 *
 * 1. `fabricatedCost()` —— 我们显示的那个数：**按字数估的**，与本体单位不通用，
 *    只保证"同一套口径、可比较、单调"（说得越多它越大）。
 * 2. `usageNote()` —— 真实用量（provider 给的 tokens）**如实说出来**，
 *    并**明确标注上面那个数是估的**。
 *
 * 规矩（别踩）：**不许**把这个估算包装成"额度"的仿制品，也**不许**把单位悄悄换成
 * tokens 而界面文案还写着"消耗"——那是用一种编造替换另一种编造。
 *
 * ⚠️ 公式原来在 `src/workbench/store.ts` 里**抄了两份**（`regenerate` 与 `nextStep` 各一处），
 * 两处一旦漂移，"同一段话重跑一次"与"第一次跑"的消耗就对不上了。现在只有这一份。
 */

/** 本机版的估算单位（本体的"额度"不通用，这里只是让数字可读）。 */
export function fabricatedCost(text: string): number {
  return Math.max(0.01, Math.round(((String(text ?? "").length / 4) * 0.01 + 0.1) * 100) / 100);
}

/** 一步上记的真实用量。 */
export type StepUsage = { inputTokens?: number; outputTokens?: number };

/**
 * 那个数 hover 时要说的话（**如实**：它是估的、本体不是这么算的、真值是多少）。
 *
 * @param cost 界面显示的那个数（估的）
 * @param usage 真实用量（拿不到就不提这一句 —— **不编**）
 * @returns 给 `title` 的一句话
 */
export function costNote(cost: number, usage?: StepUsage): string {
  const parts = [
    `本机版按字数估算：${cost.toFixed(2)}（可比较，但不是本体的"额度"——本机没有额度体系）`,
  ];
  if (usage) {
    const input = usage.inputTokens;
    const output = usage.outputTokens;
    if (typeof input === "number" || typeof output === "number") {
      parts.push(`真实用量：${input ?? "?"} 输入 / ${output ?? "?"} 输出 tokens`);
    }
  }
  return parts.join("；");
}
