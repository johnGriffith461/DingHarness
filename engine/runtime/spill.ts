import type { SpillPort, SpillWriteResult } from "../ports/spill";

/**
 * **工具结果落盘**（U02，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 产品审计与深拆的共同结论：Ding 的截断是"**截了即丢**"。
 * `read_file` 只给模型前 8000 字，`run_command` 只留最后 2000 行 / 50KB ——
 * 超出的部分**没有任何地方留下**，模型也没被告知去哪儿找。
 * 用户让它"看看这份 5 万行的日志"，它看完前 8000 字就开始编。
 *
 * 现在：超限的部分写进会话私有目录，回注一句
 *
 * ```
 * [truncated] 共 50,000 行 / 1.2 MB；只显示最后 2,000 行
 * 完整结果：<路径>（用 read_file 读它）
 * ```
 *
 * 模型能**先看尾部、再回读全文** —— 证据不丢，上下文不炸。
 *
 * ## 三条口径（照方案 §7.5）
 *
 * | 工具 | 策略 | 为什么 |
 * |---|---|---|
 * | 读 / 搜 / 列目录 | `spill`（留**头部**） | 文件与搜索结果的开头才是入口，尾部常常是无关的长尾 |
 * | 跑命令 | `tail`（留**尾部**） | 命令的结论在最后几行（测试结果、报错） |
 * | 其余 | `inline` | 结构化输出（写文件/改文件的结果）本来就不大，落盘只会多一步 |
 *
 * ## 为什么事件日志里只记路径
 *
 * 事件日志是**事件溯源**的地基，而全文可能几兆。把全文塞进事件会让库膨胀、
 * 回放变慢，而且那份正文本来就在磁盘上 —— 记路径与大小，够解释了。
 */

/** 超过这个字符数就落盘（默认 8k，与 `read_file` 给模型的上限同一口径）。 */
export const SPILL_INLINE_CHARS = 8_000;

/** 超过这个行数也落盘（命令输出 2000 行是既有上限）。 */
export const SPILL_INLINE_LINES = 2_000;

/** 回注时保留多少行预览（头部或尾部）。 */
export const SPILL_PREVIEW_LINES = 200;

/** 落盘文件保留多少天（启动/写入时清理）。 */
export const SPILL_TTL_DAYS = 7;

/** 结果处理策略。 */
export type ResultPolicy = "inline" | "spill" | "tail";

/**
 * 这个工具该走哪种策略。
 *
 * `run_command` 走 `tail`；读/搜/列目录走 `spill`；其余不落盘。
 *
 * @param toolName 工具名
 */
export function resultPolicyFor(toolName: string): ResultPolicy {
  if (toolName === "run_command") return "tail";
  if (["read_file", "search_files", "list_dir", "list_files"].includes(toolName)) return "spill";
  return "inline";
}

/** 一条输出里可以落盘的正文（不同工具把正文放在 `text` 上）。 */
function textOf(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const text = (output as Record<string, unknown>).text;
  return typeof text === "string" ? text : undefined;
}

/** 行数（末尾没有换行也算一行）。 */
export function lineCountOf(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

/** 字节数（UTF-8）。 */
export function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 人读的大小（B / KB / MB）。 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 取预览。
 *
 * @param lines 全部行
 * @param policy `tail` 取末尾，其余取开头
 * @param count 取多少行
 */
export function previewLines(lines: readonly string[], policy: ResultPolicy, count = SPILL_PREVIEW_LINES): string[] {
  if (lines.length <= count) return [...lines];
  return policy === "tail" ? lines.slice(-count) : lines.slice(0, count);
}

/**
 * 回注给模型的那段文字（**逐字可复核**，测试与界面共用这一份）。
 *
 * @param input 摘要
 */
export function spillNote(input: {
  policy: ResultPolicy;
  toolName: string;
  totalLines: number;
  shownLines: number;
  path: string;
  bytes: number;
}): string {
  const where =
    input.policy === "tail"
      ? `最后 ${input.shownLines.toLocaleString("en-US")} 行`
      : `前 ${input.shownLines.toLocaleString("en-US")} 行`;
  return [
    `[truncated] ${input.toolName} 的完整结果共 ${input.totalLines.toLocaleString("en-US")} 行 / ${humanBytes(input.bytes)}，`,
    `这里只显示${where}；完整结果：${input.path}`,
    `（需要更多内容时用 read_file 读这个路径）`,
  ].join("");
}

/** 这次输出要不要落盘。 */
export function shouldSpill(text: string): boolean {
  return text.length > SPILL_INLINE_CHARS || lineCountOf(text) > SPILL_INLINE_LINES;
}

/**
 * 把一次成功的工具输出按策略处理（落盘 + 回注预览）。
 *
 * - 不需要落盘：原样返回（**对象引用都尽量不变**，调用方不用重新读一遍）；
 * - 需要落盘：返回一份**新对象**（不改原对象 —— 事件与留痕拿到的应是同一次结果）。
 *
 * ⚠️ 落盘失败**不吞**、也不让整轮失败：如实把失败写进正文，输出仍按截断处理。
 * 证据没落盘是必须让模型知道的事（否则它会以为"完整结果就在那个路径"）。
 *
 * @param toolName 工具名
 * @param output 执行体给的原始载荷
 * @param spill 落盘端口；不给 = 不落盘（测试/最小嵌入面）
 * @param toolCallId 这次调用的 id
 */
export async function applySpill(
  toolName: string,
  output: unknown,
  spill: SpillPort | undefined,
  toolCallId: string,
): Promise<unknown> {
  const policy = resultPolicyFor(toolName);
  if (policy === "inline" || !spill) return output;
  /*
   * 已经是落盘回来的结果就**不再落一次**：`read_file` 读落盘文件时，
   * 它的输出也走这条策略 —— 不设这道闸，读一次就会再写一个新文件（越读越多）。
   */
  if (output && typeof output === "object" && "spillPath" in output) return output;
  const text = textOf(output);
  if (text === undefined || !shouldSpill(text)) return output;

  const lines = text.split("\n");
  const totalLines = lineCountOf(text);
  const preview = previewLines(lines, policy);
  const shownLines = preview.length;

  let saved: SpillWriteResult;
  try {
    saved = await spill.write({ toolCallId, toolName, text });
  } catch (error) {
    /*
     * 落盘失败：仍然按截断回注，但**不许说"完整结果在 X"** —— 那个文件不存在。
     * 模型与用户都要知道证据没保住，这是"如实"的最低要求。
     */
    return {
      ...(output as Record<string, unknown>),
      text:
        preview.join("\n") +
        `\n[警告] 完整结果落盘失败（${error instanceof Error ? error.message : String(error)}）：这次只保留了${policy === "tail" ? "尾部" : "开头"} ${shownLines} 行`,
      truncated: true,
      spillPath: null,
    };
  }

  return {
    ...(output as Record<string, unknown>),
    text: [preview.join("\n"), spillNote({ policy, toolName, totalLines, shownLines, path: saved.path, bytes: saved.bytes })].join("\n\n"),
    truncated: true,
    /* 事件/留痕只记路径与大小（不把全文写进日志） */
    spillPath: saved.path,
    spillBytes: saved.bytes,
    spillLines: saved.lines,
  };
}
