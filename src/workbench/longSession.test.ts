import { describe, expect, it } from "vitest";

import { buildHistory } from "./history";
import { compactPrompt, compactedNote, shouldCompact, totalTokens, withSummary } from "./compaction";
import type { TaskStep } from "./task";

/**
 * **100+ 轮长会话的上下文不失控**（方案 §8.3 第 4 条："长任务（100+ 轮/多次压缩）"）。
 *
 * ## 为什么要有这条
 *
 * 已有 `engine/eval/longtask.test.ts` 覆盖"**一轮里** 50+ 步"；
 * 但真实的长会话是**很多轮**，每轮都重新组装历史。这里模拟的是那一条：
 * 每轮追加两条消息，然后走 `buildHistory` → 判 `shouldCompact` → 压缩 → 回注。
 *
 * ## 断的是什么（四条，都是会真的坏的）
 *
 * 1. **上限有界**：120 轮之后发出去的 `messages` 仍然在保留额度附近，
 *    不随轮数线性增长（否则每一轮都在重发整段历史，成本平方增长）；
 * 2. **压缩真的被触发多次**：不是"阈值架空了、一次都没压"；
 * 3. **压缩之后系统提示词不膨胀**：摘要被替换而不是叠加（叠加 = 每压一次长一段）；
 * 4. **最近那一轮一定在**：压缩可以丢旧内容，但不能把用户刚说的话丢了。
 *
 * ⚠️ 这是**渲染层策略的仿真**（不需要模型）：摘要内容用固定长度的占位文本代替
 * `compactPrompt` 的真实产出。它证明"策略在这条轨迹上有界"，不证明"模型摘要得好"。
 */

const KEEP = 2000; // 保留额度（token）；小一点才能在 120 轮内压很多次

/** 模拟一轮：用户一句 + 助手带一段工具输出。 */
function turn(i: number): TaskStep[] {
  const padding = "数据".repeat(120); // 约 240 字 → 约 240 token（中文按字算）
  return [
    { id: `u${i}`, role: "user", text: `第 ${i} 轮：帮我看一下这一批数据`, at: i },
    {
      id: `a${i}`,
      role: "assistant",
      text: `第 ${i} 轮的结果：${padding}`,
      tools: [{ toolCallId: `c${i}`, name: "list_files", ok: true, line: "列了 3 个文件", output: { count: 3 } }],
      at: i,
    },
  ] as TaskStep[];
}

describe("§8.3-4：120 轮长会话（多次压缩）", () => {
  it("上下文有界、压缩多次触发、摘要不叠加、最近一轮不丢", () => {
    let steps: TaskStep[] = [];
    let summary = "";
    let compactions = 0;
    let maxSentTokens = 0;
    let maxAllTokens = 0;
    let maxSystemChars = 0;

    for (let i = 1; i <= 120; i += 1) {
      steps = [...steps, ...turn(i)];
      const history = buildHistory(steps, { keepTokens: KEEP });

      /* ① 上限有界：发出去的那一份永远在额度附近（给裁剪留一点余量） */
      const sent = totalTokens(history.messages);
      maxAllTokens = Math.max(maxAllTokens, totalTokens(history.all));
      maxSentTokens = Math.max(maxSentTokens, sent);
      expect(sent, `第 ${i} 轮发出去 ${sent} token，超过额度 ${KEEP} 太多`).toBeLessThanOrEqual(KEEP * 1.35 + 200);

      /* ② 压缩触发：用**同一把尺**判（`shouldCompact` 与 buildHistory 都用 keepTokens） */
      if (shouldCompact(history.all, KEEP)) {
        compactions += 1;
        /*
         * 真实实现把 `history.older` 交给模型压成摘要，这里用固定长度占位：
         * 我们要验的是**回注策略**（替换而不是追加），不是摘要质量。
         */
        const prompt = compactPrompt(history.older);
        expect(prompt.system.length).toBeGreaterThan(0);
        summary = `摘要 #${compactions}：${"要点。".repeat(40)}`;
        /*
         * 真实策略：**只压 older，recent 原样保留**。所以这里留最近 4 步，
         * 前面全部折成一条摘要 —— 把"最近的那一轮"也压掉是不对的（那条刚要验）。
         */
        const keepRecent = steps.slice(-4);
        steps = [{ id: `sum${compactions}`, role: "assistant", text: compactedNote(history.older.length), at: i } as TaskStep, ...keepRecent];

        /* ③ 系统提示词不膨胀：每次都是"基础 + 这一份摘要"，不是叠加 */
        const system = withSummary("基础提示词", summary);
        maxSystemChars = Math.max(maxSystemChars, system.length);
        /*
         * 上界 = 基础 + 标头与说明（与摘要正文同阶的小常数）+ 这一份摘要。
         * 关键判据是**不随压缩次数增长**：`summary` 每次都被替换，而不是接在旧的后面。
         */
        expect(
          system.length,
          `第 ${i} 轮压缩后系统提示词涨到 ${system.length} 字（摘要被叠加了？）`,
        ).toBeLessThanOrEqual("基础提示词".length + summary.length + 120);
      }

      /*
       * ④ 最近一轮一定在：压缩丢旧内容可以，丢用户刚说的那句不行。
       * 压缩之后**重新组装一次**再判 —— 判 `history`（压缩前那份）等于没验。
       */
      const afterCompaction = buildHistory(steps, { keepTokens: KEEP });
      expect(afterCompaction.all.at(-1)?.content ?? "").toContain(`第 ${i} 轮`);
      expect(afterCompaction.messages.at(-1)?.content ?? "").toContain(`第 ${i} 轮`);
    }

    expect(compactions, "120 轮里一次都没触发压缩 —— 阈值被架空了").toBeGreaterThanOrEqual(5);
    expect(maxSentTokens, "最坏的一轮发出去 0 token？").toBeGreaterThan(0);
    expect(maxSystemChars, "系统提示词一次都没被算过").toBeGreaterThan(0);

    /*
     * 反证"确实需要压缩"：压缩前那一刻的全量历史真的超过额度（否则这场 120 轮是白跑），
     * 而发出去的那一份始终有界。两条一起看，才不是"把历史整段丢了"式的有界。
     */
    expect(maxAllTokens, "压缩前全量历史从没超过额度 —— 这条测试没测到压缩").toBeGreaterThan(KEEP);
    expect(maxSentTokens).toBeLessThanOrEqual(KEEP * 1.35 + 200);
  });

  it("同样的输入不压缩时确实会超（证明上一条的'有界'不是白给的）", () => {
    /* 反证：把额度调得极大 → 一次都不压，发送量随轮数线性涨 */
    let steps: TaskStep[] = [];
    for (let i = 1; i <= 20; i += 1) steps = [...steps, ...turn(i)];
    const huge = buildHistory(steps, { keepTokens: 1_000_000 });
    const small = buildHistory(steps, { keepTokens: KEEP });
    expect(huge.truncated).toBe(false);
    expect(totalTokens(huge.messages)).toBeGreaterThan(totalTokens(small.messages) * 2);
  });
});
