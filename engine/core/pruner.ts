import type { ChatMessage } from "../../shared/ipc";

/**
 * **超长消息裁剪**（G01 的 pruner，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 上下文预算已经按模型窗口推导（D04），但**单条**消息可能自己就把预算吃掉：
 * 一次 `read_file` 的 8k 字正文、一段贴进来的 3 万行日志。`planContext` 只能在
 * **消息边界**切，切不掉一条消息的内部 —— 于是一条巨消息会把其余历史全挤出去。
 *
 * 这里对**发送给模型的那一份**做裁剪：头 4k + `[... pruned N chars ...]` + 尾 1k。
 * 保留头尾是刻意的：开头是"这是什么"，结尾通常是结论/报错。
 *
 * ## 三条口径
 *
 * 1. **只改模型视图**：日志、界面、落盘文件都不动（那是证据）。
 * 2. **原文里有完整输出时优先让它去看文件**：如果内容里已经带着落盘路径，
 *    裁剪提示里保留路径（不把"去哪儿找"裁掉）。
 * 3. **不裁最后一条 user 消息**：那是用户刚说的话，裁了这轮就答偏了。
 */

/** 头部保留多少字符。 */
export const PRUNE_HEAD_CHARS = 4_000;

/** 尾部保留多少字符。 */
export const PRUNE_TAIL_CHARS = 1_000;

/** 超过这个长度才裁。 */
export const PRUNE_THRESHOLD_CHARS = 8_000;

/** 裁剪结果。 */
export type PruneResult = { text: string; pruned: boolean; droppedChars: number };

/**
 * 裁一条超长文本。
 *
 * @param text 原文
 * @param opts 覆盖阈值（测试用）
 */
export function pruneText(
  text: string,
  opts: { head?: number; tail?: number; threshold?: number } = {},
): PruneResult {
  const head = opts.head ?? PRUNE_HEAD_CHARS;
  const tail = opts.tail ?? PRUNE_TAIL_CHARS;
  const threshold = opts.threshold ?? PRUNE_THRESHOLD_CHARS;
  if (text.length <= threshold) return { text, pruned: false, droppedChars: 0 };

  const dropped = text.length - head - tail;
  const marker = `\n\n[... 已裁掉 ${dropped.toLocaleString("en-US")} 字符（完整内容见工具结果落盘文件或原始来源） ...]\n\n`;
  return {
    text: text.slice(0, head).trimEnd() + marker + text.slice(-tail).trimStart(),
    pruned: true,
    droppedChars: dropped,
  };
}

/**
 * 裁一组消息（**不裁最后一条 user**）。
 *
 * @param messages 消息
 * @param opts 覆盖阈值
 * @returns 新数组（未裁的消息保持原对象引用）
 */
export function pruneMessages(
  messages: readonly ChatMessage[],
  opts: { head?: number; tail?: number; threshold?: number } = {},
): { messages: ChatMessage[]; pruned: number } {
  let pruned = 0;
  /*
   * 找到最后一条 user 的下标：它**永远不裁**（用户刚说的话被裁掉，这轮就会答偏）。
   * 找不到（全是 assistant）就都允许裁。
   */
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  const out = messages.map((m, index) => {
    if (index === lastUser) return m;
    const got = pruneText(m.content, opts);
    if (!got.pruned) return m;
    pruned += 1;
    return { ...m, content: got.text };
  });
  return { messages: out, pruned };
}
