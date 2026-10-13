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

/** 最近多少 token 原样保留（pi 的 `keep`）。 */
export const KEEP_TOKENS = 20000;

/**
 * 给模型输出留的额度（pi 的 `reserve`）。历史超过 `KEEP_TOKENS` 才压。
 *
 * ⚠️ **未接线（2026-10-13 如实标注）**：全仓零引用 —— 判定用的是
 * `shouldCompact(messages, keepTokens)`（`store.ts:874-887`），只看 `KEEP_TOKENS`。
 * 也就是说"给输出留额度"这件事**现在没有发生**：历史恰好顶到上限时，
 * 真正能发给模型的输入额度会被输出额度挤掉。
 *
 * 按施工手册：**C2 阶段只标注、不删** —— 它的归宿在 C3（"上下文窗口单一负责人"：
 * 单一 token 计量 + 单一压缩缝，那时才谈得上"留多少给输出"）。
 * 删了等 C3 又要加回来，而"悄悄留着不说"正是 `RESERVE_TOKENS` 这段时间的状态。
 */
export const RESERVE_TOKENS = 16384;

/** 摘要块在系统提示词里的标头。 */
export const SUMMARY_MARKER = "【更早对话的摘要】";

/**
 * 粗糙但**方向保守**的 token 估算。
 *
 * 中英混排：CJK 一字算 1，其余按 4 字符 1 个算。
 * 只用来判断"该不该压"，不追求精确 —— 所以宁可**估多**（早压一点没坏处，
 * 估少了则会真的超）。
 *
 * @param text 文本
 * @returns 估算的 token 数
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // 中日韩统一表意文字 + 全角标点 + 中文标点
    if (/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 一组消息的估算总量。 */
export function totalTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/**
 * 该不该压。
 *
 * @param messages 这次准备发的历史
 * @param keepTokens 保留额度
 * @returns 总量超过额度就该压
 */
export function shouldCompact(messages: readonly ChatMessage[], keepTokens = KEEP_TOKENS): boolean {
  return totalTokens(messages) > keepTokens;
}

/**
 * 把历史切成"要压的"与"原样保留的"。
 *
 * ⚠️ `recent` 的第一条**必须是 user** —— 否则它会以"助手的一句话"开头，
 * 模型会以为自己刚才说过那句。必要时把开头那几条 assistant 挪去 `older`。
 *
 * @param messages 历史（旧 → 新）
 * @param keepTokens 保留额度
 * @returns `older` 要压的；`recent` 原样保留的
 */
export function splitForCompaction(
  messages: readonly ChatMessage[],
  keepTokens = KEEP_TOKENS,
): { older: ChatMessage[]; recent: ChatMessage[] } {
  const recent: ChatMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;
    const cost = estimateTokens(msg.content);
    // `recent.length` 这个前置条件保证"最后一条无论多大都会留下"
    if (recent.length > 0 && used + cost > keepTokens) break;
    recent.unshift(msg);
    used += cost;
  }

  const older = messages.slice(0, messages.length - recent.length);
  // 以 assistant 开头的 recent 不合法（见上面注释）：挪进 older
  while (recent.length > 0 && recent[0]?.role !== "user") {
    const moved = recent.shift();
    if (moved) older.push(moved);
  }
  return { older, recent };
}

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
