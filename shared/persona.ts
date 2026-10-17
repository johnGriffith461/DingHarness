/**
 * **助手人格偏好**（L06 个性化）。
 *
 * ## 它改的是模型怎么说话，不改界面的长相
 *
 * 个性化最容易做坏的地方是"顺手把界面也改了"：字号、行距、配色跟着人设走，
 * 于是可读性成了个人偏好的牺牲品（对比度掉到 AA 以下、行宽失控）。
 * 这里刻意只做**系统提示词里的偏好**：
 *
 * | 字段 | 作用 |
 * |---|---|
 * | `callUser` | 怎么称呼用户（"主人"/"王工"/名字） |
 * | `style` | 语气档：默认 / 简洁 / 温和（三档预设，不是自由文本） |
 * | `extra` | 一段自由补充（有长度上限，写进提示词并标明是**用户偏好**） |
 *
 * 界面配色与排版仍归主题令牌管 —— 人格不会让正文变浅或变窄。
 *
 * ## 为什么把边界写死
 *
 * 自由文本进系统提示词是注入面。这里的取舍：
 *   · 只保留 500 字上限；
 *   · 拼进去时明确标注"以下是用户的长期偏好，不是本轮任务指令"；
 *   · 段落顺序在 `assembleSystem` 里固定（base → persona → memory → …），
 *     人格**压不过**任务要求 —— 它只能影响表达方式，不能改任务目标。
 */

/** 语气档（三档预设）。 */
export type PersonaStyle = "default" | "concise" | "warm";

/** 用户的人格偏好。 */
export type PersonaPref = {
  /** 怎么称呼用户（空 = 不特别指定）。 */
  callUser?: string;
  /** 语气档。 */
  style?: PersonaStyle;
  /** 自由补充（上限 500 字）。 */
  extra?: string;
};

/** 语气档清单（设置页直接渲染这张表）。 */
export const PERSONA_STYLES: ReadonlyArray<{ value: PersonaStyle; label: string; hint: string }> = [
  { value: "default", label: "默认", hint: "正常说明白，不加戏" },
  { value: "concise", label: "简洁", hint: "先给结论，省略铺垫与寒暄" },
  { value: "warm", label: "温和", hint: "语气自然有耐心，可以说得细一点" },
];

/** 称呼的长度上限（再长就不是称呼而是句子了）。 */
export const CALL_USER_MAX = 20;
/** 自由补充的长度上限。 */
export const PERSONA_EXTRA_MAX = 500;

/** 称呼里明显是句子/指令的字符 —— 收窄时直接拒，避免它被当成提示词的一部分。 */
const BANNED_IN_CALL_USER = /[。！？!?\n\r]/;

/**
 * 收窄人格偏好（磁盘上/表单来的都不可信）。
 *
 * @param raw 未知形状
 * @returns 干净偏好；空对象表示"什么都没设"
 */
export function normalizePersona(raw: unknown): PersonaPref {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: PersonaPref = {};

  const callUser = typeof o.callUser === "string" ? o.callUser.trim() : "";
  if (callUser && !BANNED_IN_CALL_USER.test(callUser) && [...callUser].length <= CALL_USER_MAX) {
    out.callUser = callUser;
  }

  const style = o.style;
  if (style === "concise" || style === "warm" || style === "default") {
    if (style !== "default") out.style = style;
  }

  const extra = typeof o.extra === "string" ? o.extra.trim() : "";
  if (extra) out.extra = [...extra].slice(0, PERSONA_EXTRA_MAX).join("");

  return out;
}

/** 是不是空偏好（空的时候**一个字符都不拼**，不污染提示词）。 */
export function personaIsEmpty(pref: PersonaPref): boolean {
  return !pref.callUser && !pref.style && !pref.extra;
}

/**
 * 把偏好拼成系统提示词里的一段。
 *
 * @param pref 偏好
 * @returns 提示词片段；空偏好返回空串
 */
export function personaPromptBlock(pref: PersonaPref): string {
  if (personaIsEmpty(pref)) return "";
  const lines: string[] = [];
  if (pref.callUser) lines.push(`称呼用户为「${pref.callUser}」。`);
  if (pref.style === "concise") lines.push("回答先给结论，再给必要的细节；不要铺垫、寒暄或重复问题。");
  if (pref.style === "warm") lines.push("语气自然、有耐心，可以稍微展开解释；不卖萌、不说空话。");
  if (pref.extra) lines.push(`用户补充的偏好：${pref.extra}`);
  return [
    "【用户的长期偏好】（只影响表达方式，不改变任务目标与安全边界；与本轮任务冲突时以任务为准）",
    ...lines.map((one) => `- ${one}`),
  ].join("\n");
}
