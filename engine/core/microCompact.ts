import type { ChatMessage } from "../../shared/ipc";

/**
 * **microCompact：只清"可重新取回"的旧工具结果**（T3，2026-10-19）。
 *
 * ## 它解决什么
 *
 * 长会话里真正撑爆上下文的是**工具输出**：一次 `read_file` 几千行、一次搜索几十条命中。
 * 而这些东西有个特点：**随时可以再取一次**（路径还在、查询还在）。
 *
 * 普通压缩（`planContext` 的整段截断）只能"连着对话一起丢"——
 * 丢完之后模型连"我刚才查过什么"都不知道了。microCompact 做的是**只清结果、留对话**：
 *
 * ```
 * 助手：我看了这个文件，问题在第三段。
 * （本步工具：read_file 某个源文件（输出：…8000 字…））
 * ```
 * →
 * ```
 * 助手：我看了这个文件，问题在第三段。
 * （本步工具：read_file 的结果已清理 —— 可按原路径重新读取）
 * ```
 *
 * 模型仍然知道"读过 a.ts"，需要时再读一次即可。**这是"只清可重取的结果、保留语义"**，
 * 和"整段扔掉"是两种不同的取舍。
 *
 * ## 三条硬边界（写死在代码里，不靠调用方记得）
 *
 * 1. **只清可重取的工具**：`read_file` / `search_files` / `list_files` / `grep` / web 读取。
 *    编辑（`write_file` / `edit_file`）与命令（`run_command`）的结果**永不清** ——
 *    那些是"发生过的事"，清掉之后模型会重复劳动甚至重复副作用。
 * 2. **最近 N 条不动**（默认 6），且**最后一条永远不动**：那是用户刚说的话。
 * 3. **只改发给模型的那份视图**，不改事件日志 —— 日志是账，视图是投影。
 *
 * ## 与 `planContext` 的关系
 *
 * 它是 `planContext` **之前**的一步：先把旧结果换成占位，再看还剩多少额度。
 * 顺序反了（先截断再清）就等于"先扔掉旧对话、再去清已经不存在的工具结果"。
 */

/** 默认可清理的工具（都是"读"，不影响世界状态，重取安全）。 */
export const RETRIEVABLE_TOOLS: readonly string[] = [
  "read_file",
  "search_files",
  "list_files",
  "list_dir",
  "grep",
  "knowledge_search",
  "browser_snapshot",
  "web_fetch",
  "web_search",
];

/** 工具块的开头标记（由 `history.ts` 的 `withToolLines` 生成）。 */
const TOOL_BLOCK_START = "（本步工具：";

/** 清理后留下的那句话（要能让模型判断"要不要重读"）。 */
export function clearedMarker(toolNames: readonly string[]): string {
  const names = [...new Set(toolNames)].join("、");
  return `（本步工具：${names} 的结果已清理 —— 可按原路径/原查询重新取回）`;
}

/** 从工具块文本里抠出工具名（`read_file 某个文件（输出：…）` → `read_file`）。 */
export function toolNamesOf(block: string): string[] {
  return block
    .split("；")
    .map((part) => part.trim().split(/[\s（(]/)[0] ?? "")
    .filter(Boolean);
}

/**
 * 判断一条消息的工具块能不能清。
 *
 * @param block 工具块正文（不含 `（本步工具：` 前缀）
 * @returns 可以清时返回工具名列表；否则 `null`
 */
export function clearableTools(block: string): string[] | null {
  const names = toolNamesOf(block);
  if (!names.length) return null;
  /* 有一个不可重取的，就整块保留（保守：宁可多占额度，也不要让模型以为做过的事没发生） */
  if (names.some((name) => !RETRIEVABLE_TOOLS.includes(name))) return null;
  return names;
}

/** 一条消息的清理结果。`cleared` 表示这条真的被改了。 */
export type MicroCompactResult = {
  messages: ChatMessage[];
  cleared: number;
  /** 估算省下的字符数（不是 token：调用方的计量只认 `estimateTokens`）。 */
  savedChars: number;
};

/**
 * 清理旧的可重取工具结果。
 *
 * @param messages 消息列表（旧 → 新）
 * @param opts `keepRecent`：最近多少条不动（默认 6）；`keepRounds`：最近几轮整轮不动
 *   （默认 2，按"用户消息"计轮）；`enabled`：总开关
 */
export function microCompact(
  messages: readonly ChatMessage[],
  opts: { keepRecent?: number; keepRounds?: number; enabled?: boolean } = {},
): MicroCompactResult {
  const enabled = opts.enabled !== false;
  const keepRecent = Math.max(1, opts.keepRecent ?? 6);
  const keepRounds = Math.max(1, opts.keepRounds ?? 2);
  if (!enabled) return { messages: [...messages], cleared: 0, savedChars: 0 };

  const cutoff = Math.max(0, messages.length - keepRecent);
  /* 最近 N 轮的起点：从后往前数第 N 条 user 消息（找不到就从头算） */
  let seenRounds = 0;
  let roundStart = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "user") continue;
    seenRounds += 1;
    if (seenRounds === keepRounds) {
      roundStart = i;
      break;
    }
  }
  let cleared = 0;
  let savedChars = 0;

  const out = messages.map((message, index) => {
    /* ① 最近 N 条不动；② 最近 N 轮整轮不动；③ 最后一条永远不动（用户刚说的话） */
    if (index >= cutoff || index >= roundStart || index === messages.length - 1) return message;
    /* 只处理助手消息里带工具块的那些（用户说的话没有工具块） */
    const at = message.content.indexOf(TOOL_BLOCK_START);
    if (at < 0) return message;

    const blockStart = at;
    const blockEnd = message.content.lastIndexOf("）");
    if (blockEnd <= blockStart) return message;

    const block = message.content.slice(blockStart + TOOL_BLOCK_START.length, blockEnd);
    const names = clearableTools(block);
    if (!names) return message;

    const head = message.content.slice(0, blockStart).trimEnd();
    const tail = message.content.slice(blockEnd + 1).trimStart();
    const next = `${head ? `${head}\n\n` : ""}${clearedMarker(names)}${tail ? `\n\n${tail}` : ""}`;

    /*
     * ⚠️ **不省就不清**（2026-10-19 单测抓到的真边界）：
     * 占位文案比原来那段还长时（工具输出很短，例如「ok」），
     * 换了反而让上下文变大 —— 那不是压缩，是反压缩。
     * 留 20 字符的余量：只省几个字不值得丢掉原文。
     */
    const saved = message.content.length - next.length;
    if (saved < 20) return message;

    cleared += 1;
    savedChars += saved;
    return { ...message, content: next };
  });

  return { messages: out, cleared, savedChars };
}
