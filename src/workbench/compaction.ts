import type { ChatMessage } from "@shared/ipc";

/**
 * 上下文压缩的**纯逻辑部分**（§149）。
 *
 * ## 参考实现（pi）的三条
 *
 * | pi | 搬过来的理由 |
 * |---|---|
 * | `reserve 16384` —— 给输出留的额度 | 压完不能反过来把输出挤掉 |
 * | `keep 20000` —— 最近多少 token 原样保留 | 最近的上下文最要紧 |
 * | **切割点不许落在 tool result 上** | 切在工具结果上，模型会看到"调了工具却没有结果" |
 *
 * ## 好消息：第三条在我们这里**自动成立**
 *
 * 历史里的工具留痕是**折进该条消息文本**的（§148 的 `withToolLines`），
 * 一条消息就是一个完整的 `{ role, content }` —— 所以**按消息边界切**就不可能切在工具结果中间。
 *
 * > 这条值得记：**结构选对了，某些约束就不需要额外代码去守。**
 * > 反过来说，哪天换成结构化 tool 消息（§148.2 那个"以后"），这条约束就**重新需要代码守**。
 *
 * ## 压缩不动本地历史
 *
 * 这一层只决定"**这一次发给模型什么**"。本地那份完整记录一个字都不改 ——
 * 用户回头翻对话，必须还是原文。
 */

/*
 * ⚠️ `RESERVE_TOKENS = 16384` **已在 C3 删除**（手册给的裁定时机："要么被用要么被删"）。
 *
 * 为什么是删而不是接上：留额度要先知道**每个模型的上下文上限**，而
 * `electron/ipc/aiProviders.ts` 里没有这个字段 —— 我们只知道有哪几个模型，
 * 不知道它们能装多少。硬编一个数就是编数据。
 * 等 provider 带上真实上限，`engine/core/context.ts` 的 `planContext` 加一个
 * `reserveTokens` 参数即可（**那时**它是"上限减去保留"，而不是凭空定的 16384）。
 */

/** 摘要块在系统提示词里的标头。 */
export const SUMMARY_MARKER = "【更早对话的摘要】";

/*
 * 计量与切分（`estimateTokens` / `totalTokens` / `shouldCompact` / `planContext`）
 * **搬去了 `engine/core/context.ts`**（C3）—— 那是"上下文窗口的唯一负责人"：
 * 聊天与工作台两条路都调它，免得同一条规矩在两处各长一份。
 *
 * 这里只留**压缩本身**：怎么把要压的那些拼成一段、摘要怎么挂回系统提示词。
 */
export { KEEP_RECENT_TOKENS as KEEP_TOKENS, estimateTokens, totalTokens, shouldCompact, planContext } from "@engine/core/context";

/**
 * 造"把这段对话压成要点"的请求。
 *
 * 刻意**只保留四类东西**：决定、数字与专有名词、用户给的约束、未完成的事。
 * 寒暄与过程不留 —— 那些正是压缩要丢掉的部分。
 *
 * @param older 要压的那批消息
 * @returns `system` 与 `user`（走同一个 AI 通道，不另配渠道）
 */
export function compactPrompt(older: readonly ChatMessage[]): { system: string; user: string } {
  const system = [
    "你把一段较早的对话压缩成要点，供后续对话继续使用。",
    "**只保留**这四类：已确定的决定、出现过的数字与专有名词、用户提出的约束与偏好、尚未完成的事。",
    "不要写寒暄、不要写过程与客套。用要点，最多 200 字。",
    "⚠️ 不要编造原文里没有的内容；看不清就不写。",
  ].join("\n");
  const user = older.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`).join("\n\n");
  return { system, user };
}

/**
 * 把摘要拼进系统提示词。
 *
 * **为什么放系统侧、不伪装成一条消息**：伪装成消息会让模型把它当成
 * "真发生过的一轮"，进而以为用户说过摘要里的话。放系统侧并标明是摘要，最不容易被误读。
 *
 * @param system 原系统提示词
 * @param summary 摘要正文（空则原样返回）
 * @returns 拼好的系统提示词
 */
export function withSummary(system: string, summary: string): string {
  const text = summary.trim();
  if (!text) return system;
  return `${system}\n\n${SUMMARY_MARKER}\n（以下是更早对话的压缩要点，不是用户这次说的话）\n${text}`;
}

/** 界面上那行提示的文案（用户有权知道"这段上下文被压过"）。 */
export function compactedNote(olderCount: number): string {
  return `更早的 ${olderCount} 条对话已压缩为摘要`;
}

/**
 * 把 ICM 索引挂到系统提示词末尾（V6-1c）。
 *
 * 与 `withSummary` 分开：摘要来自一次**模型调用**，索引来自**事件流事实**。
 * 两者在提示词里的标头也不同（索引自带 `【上下文索引（不是摘要）】`），
 * 模型不会把"事实锚点"当成"上一轮的措辞"来模仿。
 */
export function withContextIndex(system: string, indexText: string): string {
  const text = indexText.trim();
  if (!text) return system;
  return `${system}\n\n${text}`;
}

/** 界面提示：走的是索引接力，不是摘要（事件流还在，可回放核对）。 */
export function indexedNote(olderCount: number): string {
  return `更早的 ${olderCount} 条对话已换成上下文索引（事件流保留，可回放核对）`;
}

/**
 * 一组消息的**签名**（用于摘要缓存）。
 *
 * 为什么要有：不缓存的话，**每一次追问都会多花一次压缩调用** ——
 * 用户问三句就白花三次。签名一样就说明"要压的还是同一批"，直接复用上次的摘要。
 *
 * 用 djb2 而不是把原文存起来：原文可能就是几十 KB，为缓存再留一份不划算。
 *
 * @param messages 要压的那批
 * @returns `条数:哈希` 形式的签名
 */
export function signatureOf(messages: readonly ChatMessage[]): string {
  let hash = 5381;
  for (const m of messages) {
    for (let i = 0; i < m.content.length; i += 1) {
      hash = ((hash * 33) ^ m.content.charCodeAt(i)) >>> 0;
    }
  }
  return `${messages.length}:${hash.toString(36)}`;
}
