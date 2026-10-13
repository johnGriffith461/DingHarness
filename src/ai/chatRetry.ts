import type { ChatMessageRecord } from "./chatStore";

/**
 * 「重试」要动的那几块（§187 界面体检 P1）。
 *
 * ## 为什么单独一个文件
 * 这段判断本来写在 `chatStore.ts` 的 `retry` 里 —— 那里已经 935 行，被
 * `structureGuard` 拦下（`.ts ≤ 900`）。而**拆它的收益不只是行数**：
 * "撤哪些、重发什么"是纯逻辑，跟 zustand、跟 IPC 都没关系，
 * 拿出来之后可以直接单测（`chatRetry.test.ts`），不必起一个 store。
 *
 * ## 语义：撤掉"失败的那条回复"和"它对应的那次提问"，用同一段话重发
 * 不这么做就有两种坏结果：
 *   · 只删失败回复 → 历史里留下"问了一句没人答"的残缺；
 *   · 只重发不删   → 用户的话出现两遍，模型会以为他连问了两遍。
 *
 * ⚠️ 重发的只有**用户那句话本身**：原来附带的上下文块（引用芯片 / 素材上下文）
 * 没有存在消息记录里（会话日志里也没有），所以重发不会重新带上它们。
 * 这是**已知差别**，如实写在这里 —— 不是"以为带上了"。
 *
 * ⚠️ 还有一条**如实记着**的差别：这次撤销只作用于**当前界面**。
 * 会话日志是**只追加**的（C2 的规矩：记下来的事不许悄悄抹掉），
 * 所以重启之后，那次失败的问答会**跟着日志一起回来**（`chatRestore.ts` 按轮恢复），
 * 界面上会同时看到原来那次失败和重试后的这次。
 * 要做到"重启也不出现"，得给日志加一种"这条作废"的事件 —— 那是新功能，
 * 不是这里顺手能加的，所以现在这样明说，不假装它不存在。
 */
export type RetryPlan = {
  /** 重发这句话。空串表示"没有可重发的提问"（只把失败回复收干净）。 */
  text: string;
  /** 撤完之后应当留下的消息（`messageId` 及其之后全部去掉，起点是那次提问）。 */
  keep: ChatMessageRecord[];
};

/**
 * 算出重试要做什么；不值得重试时返回 `null`。
 *
 * @param list 当前会话的消息（顺序即时间顺序）
 * @param messageId 点「重试」的那条**失败**回复
 * @returns 要撤什么、要重发什么；`messageId` 不在列表里时返回 `null`
 */
export function planRetry(list: ChatMessageRecord[], messageId: string): RetryPlan | null {
  const failedAt = list.findIndex((m) => m.id === messageId);
  if (failedAt < 0) return null;

  /* 往前找最近的一条用户消息 —— 那才是这次要重发的内容。 */
  let askedAt = -1;
  for (let i = failedAt - 1; i >= 0; i -= 1) {
    if (list[i].role === "user") {
      askedAt = i;
      break;
    }
  }

  if (askedAt < 0) {
    /*
     * 找不到提问（理论上不该发生：助手消息总是跟在提问后面）。
     * 这时候**只把那条失败回复收干净** —— 至少别让用户对着一颗点了没反应的
     * 「重试」发呆（那又是一颗假按钮）。
     */
    return { text: "", keep: list.filter((m) => m.id !== messageId) };
  }

  return { text: list[askedAt].content, keep: list.slice(0, askedAt) };
}
