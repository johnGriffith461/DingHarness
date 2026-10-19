import type { ChatMessage } from "@shared/ipc";
import { KEEP_RECENT_TOKENS as KEEP_TOKENS, omittedNote, planContext } from "@engine/core/context";
import { pruneMessages } from "@engine/core/pruner";
import { microCompact } from "@engine/core/microCompact";
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
 * ## 上限（C3 改过）
 *
 * **不再按条数截断**。原来这里是"只保留最近 `HISTORY_LIMIT = 20` 条"，
 * 后果是那段硬截断**把压缩阈值架空了**：20 条消息通常远不到 2 万 token，
 * 于是"该压就压"这个判定**几乎永远不会触发**（压了个寂寞）。
 *
 * 现在：**额度由 `engine/core/context.ts` 一处说了算**
 * （`planContext`：按 token 保留最近的一段，只在消息边界切）。
 * 截断仍然**是诚实的截断**：切掉的部分会被丢掉，所以调用方在 `truncated` 为真时
 * 要在系统提示词里说明"更早的对话已省略"。
 */

/**
 * 一次工具调用的**输出**进历史时的**安全阀**（补完③，账本 P3）。
 *
 * ## 它原来是 400 字，那是"显示口径"在替"上下文预算"做决定
 *
 * 400 字的后果是具体的：`memory_list` 列出 20 条记忆、`schedule_list` 列出十几条任务，
 * 到了历史里只剩前几条 —— 模型于是**不知道后面还有什么**，
 * 用户接着问"刚才那几条分别是什么"，它只能猜或再调一次。
 *
 * 现在**由上下文额度说了算**（C3 的 `planContext`：按 token 留最近的一段，
 * 该裁的时候会如实说"更早的对话已省略"）—— 这才是"谁该截断"的**唯一**负责人。
 *
 * ⚠️ 保留这个常量只作**安全阀**：一条工具输出**单独**就超过整个额度时
 * （比如把整篇文档吐回来），它会把其余历史全挤掉。8000 字是"比 400 宽二十倍、
 * 又还能被预算兜住"的量级。真触发时**写明**（不假装完整）。
 */
export const TOOL_OUTPUT_LIMIT = 8000;

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
export function buildHistory(
  steps: TaskStep[],
  /**
   * `factor`：校准系数（补完④）：由调用方用**上一轮真实 usage** 算出来（`calibrationOf`）。
   * `keepTokens`：保留额度（2026-10-16，审计 P156）。
   *
   * ⚠️ 为什么额度要能注入：调用方（`taskRuntime`）**同一条回合里**还要拿
   * `compactKeepTokens()`（按当前模型算）去决定"该不该压"——
   * 如果这里用固定的 `KEEP_RECENT_TOKENS`，那就成了"组装历史用一把尺、
   * 判断要不要压用另一把尺"：上限大的模型永远压不动，上限小的模型第一轮就超。
   * 不传时保持原样（默认值），单测与旧调用零漂移。
   */
  opts: { factor?: number; keepTokens?: number; microCompact?: boolean } = {},
): {
  /** 这次要发的历史（切过之后 = recent；没超额度 = 全量）。 */
  messages: ChatMessage[];
  truncated: boolean;
  /** 全量（未切）；ICM 拿它算"该不该压"的总量。 */
  all: ChatMessage[];
  /** 被切掉的那批（旧 → 新）；摘要/索引从它生成。 */
  older: ChatMessage[];
} {
  const all: ChatMessage[] = [];
  for (const step of steps) {
    const text = withToolLines((step.text ?? "").trim(), step.tools);
    // 空步骤不发（真为空的就跳过；仅有工具留痕的步骤不算空）
    if (!text.trim()) continue;
    all.push({ role: step.role, content: text });
  }
  /*
   * 留多少**由额度说了算**（C3）：`planContext` 按 token 从最新往回留，
   * 只在消息边界切、最后一条必留、保留段以 user 开头。
   *
   * 原来这里还有一道"最多 20 条"的硬截断 —— 它把压缩阈值架空（见文件头）。
   * 现在条数不再是判据：同样 20 条，短消息与长消息能差几十倍。
   */
  /*
   * **G01 microCompact（2026-10-19）**：先把旧的「可重取」工具结果换成占位，再算额度。
   *
   * 顺序不能反：先截断再清，等于先把旧对话扔掉、再去清已经不在的东西。
   * 它只清读类工具（read/search/list/grep/web）；编辑与命令的结果永不清 ——
   * 那些是发生过的事，清掉会让模型重复劳动甚至重复副作用。
   */
  const compacted = microCompact(all, { enabled: opts.microCompact !== false });
  const { older, recent } = planContext(compacted.messages, opts.keepTokens ?? KEEP_TOKENS, { factor: opts.factor ?? 1 });
  /*
   * G01：**发送给模型的那一份**再裁一次超长单条（头 4k + 尾 1k）。
   *
   * `planContext` 只在消息边界切 —— 一条 3 万字的工具输出会自己把预算吃光，
   * 把其余历史全挤掉。裁的是**模型视图**：`all` / `older` 仍是原文（日志与摘要用得到）。
   */
  const prunedRecent = pruneMessages(recent).messages;
  /*
   * 三个出口都留着（V6-1c）：原来只返回 `recent`，于是调用方拿到的已经是
   * 切过的历史，再对它调 `shouldCompact` **恒为假** —— 摘要那条路形同虚设，
   * 被切掉的 `older` 只留下一句"已省略"就没了。现在旧内容可交给 ICM
   * 决定"压成摘要"还是"生成索引"。
   */
  return { messages: prunedRecent, truncated: older.length > 0, all, older };
}

/**
 * 历史被截断时追加到系统提示词末尾的那句。
 *
 * 必须让模型知道"你看不到全部" —— 否则它会把"没在上下文里"当成"没发生过"，
 * 于是重复问用户已经回答过的事。
 */
export function truncatedNote(): string {
  /*
   * 文案搬去 `engine/core/context.ts`（C3）：聊天侧也要说同样的话。
   * ⚠️ 措辞随之变了：不再写"你只能看到最近 20 条消息" ——
   * 那个"20 条"是硬截断留下的数字，而切分现在按**额度**走，条数不是判据。
   */
  return omittedNote("trimmed");
}
