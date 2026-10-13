import type { ChatMessage } from "@shared/ipc";
import type { ToolTrace } from "@shared/agentTools";
import type { TaskStep } from "./task";

/**
 * 把一步对话组装成**发给模型的消息数组**（§147）。
 *
 * ## 为什么要有这一层
 *
 * 之前每次请求只发**一条** user 消息（内容由提示词构造器拼好），
 * 而任务视图里那个输入框提交时调的是 `createTask` —— 于是在已有对话里继续说话
 * 会**新建一个任务**。也就是说：**根本没有多轮对话**。
 *
 * 这与本体不一样（它的「主对话」是多轮的、历史对话页里每行是一整段对话的摘要）。
 *
 * ## 上限
 *
 * 只保留最近 `HISTORY_LIMIT` 条。**这是一个诚实的截断，不是压缩** ——
 * 更早的内容会被丢掉，所以调用方在 `truncated` 为真时要在系统提示词里**说明**
 * "更早的对话已省略"，让模型知道自己看到的不完整。
 *
 * （真正的压缩要按 pi 的参数做：`reserve 16384` / `keep 20000`、
 *   切割点不许落在 tool result 上 —— 那是批次 4。）
 */

/**
 * 一次请求最多回看多少条历史消息。
 *
 * 取值理由：本机版一次对话通常十来轮，20 条够连续；再多就该走压缩而不是硬塞。
 */
export const HISTORY_LIMIT = 20;

/**
 * 一次工具调用的**输出**最多带多少字进历史。
 *
 * 取值理由：够模型读懂"工具到底返回了什么"（几条记忆、一段结构），
 * 又不至于把一次上下文塞爆。**超了就截断并写明**，不假装完整。
 */
export const TOOL_OUTPUT_LIMIT = 400;

/**
 * 把工具的**输出**说成一段能进历史的文本（§163）。
 *
 * ## ⚠️ 为什么必须有这一步
 *
 * §148 的 `withToolLines` 只搬了 `line`（界面上那行小字，例如
 * `⚙ 记忆：已列出 2 条`）。于是**跨轮**的时候模型只知道"我调过 memory_list、有 2 条"，
 * **看不到那 2 条是什么** —— 用户接着问"刚才那几条分别是什么"，
 * 模型只能猜或者再调一次。
 *
 * 而 `ToolTrace.output` 一直是**记下来了的**（§144 就存了），只是没进历史。
 * 这一步就是把它接上：**工具的输出属于"发生过的事"，就该进对话历史**。
 *
 * 规矩：
 * - `pending`（还在等审批、**没执行**）的不带输出 —— 它压根没产出；
 * - 输出为空/undefined 时不加那一段（不留一个空的"输出："）；
 * - 对象用 JSON 说，长文本截断并**注明截断**。
 *
 * @param output 工具输出（`ToolTrace.output`）
 * @returns 可以直接拼进文本的一段；没有输出时返回空串
 */
export function outputText(output: unknown): string {
  if (output === undefined || output === null) return "";
  let text: string;
  if (typeof output === "string") text = output;
  else {
    try {
      text = JSON.stringify(output);
    } catch {
      text = String(output);
    }
  }
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  // 工具输出里的「待确认」信封不算输出
  if (/^\{"pending":true\}$/.test(flat)) return "";
  return flat.length > TOOL_OUTPUT_LIMIT ? `${flat.slice(0, TOOL_OUTPUT_LIMIT)}…（已截断）` : flat;
}

/**
 * 把这一步用过的工具**折进文本**（§148，§163 补上输出）。
 *
 * ## 为什么必须带上
 *
 * 多轮成立之后（§147），历史里原来只有**文本**。于是第二轮的模型看不到
 * "上一轮我调过工具、结果如何" —— 后果很具体：
 * - 用户说「记住 X」→ 工具真的存了 → 用户再说「再存一次」→ 模型不知道已经存过，**重复存**；
 * - 用户**拒绝了**某个动作 → 模型不知道被拒过，**换个说法再试一次**；
 * - 用户问「刚才列出来的几条分别是什么」→ 上一步工具**返回过**这个内容，
 *   但历史里只有一句"已列出 2 条"，模型只能猜（§163 修的就是这条）。
 *
 * ## 为什么折进文本、而不是发真正的 tool 消息
 *
 * 我们的 `ChatMessage` 是 `{ role, content: string }`（`shared/ipc.ts`），
 * 而 AI SDK 的 tool 消息需要 `tool_call_id` 配对的内容分片 —— 那是另一套消息形状，
 * 会把共享类型与主进程一起改大。**这一版的取舍是**：先让模型**知道**发生过什么
 * （文本足够），等真需要"让模型重放工具调用"时再换成结构化消息。
 *
 * ⚠️ 界面上那行小字**原样搬进历史**（不另写一套说法，§144 的同一条要求），
 * **输出**则附在它后面 —— 一行是"做了什么"，输出是"得到了什么"。
 *
 * @param text 这一步的正文
 * @param tools 这一步用过的工具留痕
 * @returns 折好之后的文本
 */
export function withToolLines(text: string, tools?: ToolTrace[]): string {
  const lines = (tools ?? []).map((t) => {
    const head = (t.line ?? "").trim();
    // 没执行的（等审批）不带输出：它没有产出，编一段"输出"会误导
    const out = t.pending ? "" : outputText(t.output);
    if (head && out) return `${head}（输出：${out}）`;
    return head || (out ? `（输出：${out}）` : "");
  });
  const kept = lines.filter(Boolean);
  if (!kept.length) return text;
  /*
   * 用「本步工具」这样的前缀把来源标出来，别让它看起来像助手自己说的一句话 ——
   * 否则模型会把界面文案当成自己的语气模仿（已经出现过一次类似的模仿）。
   */
  return `${text}\n\n（本步工具：${kept.join("；")}）`;
}

/**
 * @param steps 任务里**已有的**步骤（不含这次要发的新消息）
 * @param limit 最多回看几条
 * @returns `messages` 按原顺序（旧 → 新）；`truncated` 表示是否丢过更早的
 */
export function buildHistory(steps: TaskStep[], limit = HISTORY_LIMIT): { messages: ChatMessage[]; truncated: boolean } {
  const all: ChatMessage[] = [];
  for (const step of steps) {
    const text = withToolLines((step.text ?? "").trim(), step.tools);
    // 空步骤不发（真为空的就跳过；仅有工具留痕的步骤不算空）
    if (!text.trim()) continue;
    all.push({ role: step.role, content: text });
  }
  const truncated = all.length > limit;
  return { messages: truncated ? all.slice(-limit) : all, truncated };
}

/**
 * 历史被截断时追加到系统提示词末尾的那句。
 *
 * 必须让模型知道"你看不到全部" —— 否则它会把"没在上下文里"当成"没发生过"，
 * 于是重复问用户已经回答过的事。
 */
export function truncatedNote(limit = HISTORY_LIMIT): string {
  return `【说明】更早的对话已省略，你只能看到最近 ${limit} 条消息。如果缺关键信息，直接说不确定，不要猜。`;
}
