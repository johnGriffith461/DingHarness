/**
 * P0-07：`ask_user` —— 需要澄清时用**工具**提问，而不是在正文里塞问卷模板。
 *
 * 上游一致：OpenCode 的 `question`、Cline 的 `ask_question`、Codex 的
 * `request_user_input` 都是工具。工具化的好处是可结构化落到问题卡上，
 * 而正文里的 `<ask>` 块要靠正则解析、模型稍一自由发挥就解析不到。
 */

export const ASK_USER_TOOL = "ask_user";

/** 一张问题最多几个选项（再多卡片放不下，用户也懒得读）。 */
export const ASK_USER_MAX_OPTIONS = 5;

export type AskOption = { label: string; description?: string };

export type AskRequest = {
  question: string;
  options: AskOption[];
  allowFreeText: boolean;
};

export type NormalizeAskResult = { ok: true; ask: AskRequest } | { ok: false; error: string };

/**
 * 校验并规整模型给的提问。
 *
 * - 问题不能为空；
 * - 选项最多 {@link ASK_USER_MAX_OPTIONS} 个，缺 label 的丢掉；
 * - 没有选项是合法的（纯自由文本问题）；
 * - `allow_free_text` 缺省为 true（用户总该能自己写一句）。
 */
export function normalizeAsk(raw: unknown): NormalizeAskResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "ask_user 的参数必须是一个对象" };
  const o = raw as Record<string, unknown>;
  const question = typeof o.question === "string" ? o.question.trim() : "";
  if (!question) return { ok: false, error: "question 不能为空" };
  if (question.length > 500) return { ok: false, error: "question 不能超过 500 字" };
  const rawOptions = Array.isArray(o.options) ? o.options : [];
  if (rawOptions.length > ASK_USER_MAX_OPTIONS) {
    return { ok: false, error: `选项最多 ${ASK_USER_MAX_OPTIONS} 个（现在是 ${rawOptions.length} 个）` };
  }
  const options: AskOption[] = [];
  for (const item of rawOptions) {
    if (!item || typeof item !== "object") continue;
    const opt = item as Record<string, unknown>;
    const label = typeof opt.label === "string" ? opt.label.trim() : "";
    if (!label) continue;
    const description = typeof opt.description === "string" ? opt.description.trim() : "";
    options.push({ label: label.slice(0, 60), ...(description ? { description: description.slice(0, 200) } : {}) });
  }
  return {
    ok: true,
    ask: { question: question.slice(0, 500), options, allowFreeText: o.allow_free_text !== false },
  };
}

/** 工具结果里那一行（问答本身走问题卡，不在这里复述）。 */
export function describeAskResult(): string {
  return "已向用户提问（等回答）";
}

/** 从一条 tool-result 的 output 里取提问（桌面侧映射成问题卡用）。 */
export function askFromOutput(output: unknown): AskRequest | undefined {
  if (!output || typeof output !== "object") return undefined;
  const ask = (output as { ask?: unknown }).ask;
  if (!ask || typeof ask !== "object") return undefined;
  const got = normalizeAsk(ask);
  return got.ok ? got.ask : undefined;
}
