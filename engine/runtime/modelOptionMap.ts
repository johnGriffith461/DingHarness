/**
 * **模型参数映射**（T0）—— Ding 自己的设计，**不是**搬别人的表达式语言。
 *
 * ## 为什么不用 CEL / 任何表达式语言
 *
 * 这件事的真实需求只有两种：
 *
 * 1. **改字段名**：我的中转站认 `max_completion_tokens`，不认 `max_tokens`；
 * 2. **按档位改值**：`high` 档要发 `{"reasoning":{"effort":"high"}}`。
 *
 * 这两种都是**映射**，不是**编程**。为一个"换个键名"的需求内嵌一门表达式语言，
 * 代价是：
 * - 多一个可执行表面（解析器 + 求值器，任何一个 bug 都是钱和安全的事）；
 * - 用户要先学一门语言才能改一个键名。
 *
 * 所以 Ding 的选择是**声明式**：
 *
 * ```jsonc
 * // 1) 占位符：把值填进去
 * { "max_completion_tokens": "{{maxOutputTokens}}" }
 * { "reasoning": { "effort": "{{reasoningLevel}}" } }
 *
 * // 2) 规则表：按条件选一条（从上往下，第一个命中的生效）
 * [
 *   { "when": { "reasoningLevel": "high" }, "set": { "reasoning": { "effort": "high" }, "verbosity": "high" } },
 *   { "set": { "reasoning": { "effort": "low" } } }
 * ]
 * ```
 *
 * 规则表能表达条件；占位符能表达取值。**两者都不需要求值任意代码。**
 *
 * ## 合并语义
 *
 * 合并用 **RFC 7396（JSON Merge Patch）**：`null` 删键、对象逐层合并、其余整体替换。
 * 这是**标准**，不是某家的发明 —— 所以这里没有可"抄"的东西。
 */

/** 映射的输入值（只能是这两种：档位名与 token 数）。 */
export type OptionValues = {
  reasoningLevel?: string;
  maxOutputTokens?: number;
};

/** 一个 JSON 值（映射结果只允许是 JSON）。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 占位符：`{{reasoningLevel}}` / `{{maxOutputTokens}}`，允许内侧空格。 */
const PLACEHOLDER = /\{\{\s*(reasoningLevel|maxOutputTokens)\s*\}\}/g;

/**
 * **保留键**：映射不许碰它们。
 *
 * 这是 Ding 对"参数映射"边界的定义：映射改的是**参数名与取值**，
 * 不是把请求结构换掉（换结构该去改协议适配层，不该在表单里做）。
 * 出现在映射结果里 → 拒绝保存（见 `validateOptionMap`）。
 */
export const RESERVED_KEYS = ["model", "messages", "tools", "stream", "input", "system"] as const;

/** 一条规则。`when` 省略 = 无条件命中（相当于默认分支）。 */
export type OptionMapRule = {
  when?: { reasoningLevel?: string; maxOutputTokensMin?: number };
  set: JsonValue;
};

/**
 * 映射声明：**对象**（直接是补丁）或 **规则数组**（按条件选一条）。
 *
 * 两种都接受，是因为两种场景差别很大：改字段名是一句话的事（对象），
 * 按档位分支才需要规则表。强迫所有人写规则表只会让简单的事变复杂。
 */
export type OptionMapSpec = { [key: string]: JsonValue } | OptionMapRule[];

/** 校验失败的异常（消息直接给用户看，所以要写成人话）。 */
export class OptionMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptionMapError";
  }
}

/**
 * 解析声明（从文本）。**只接受 JSON** —— 不用 json5/宽松解析器：
 * 少一个解析器就少一类"在某个边角上行为不同"的问题。
 *
 * @param text 用户输入的文本
 * @returns 声明对象
 * @throws OptionMapError 不是合法 JSON / 形状不对
 */
export function parseOptionMap(text: string): OptionMapSpec {
  const trimmed = text.trim();
  if (!trimmed) throw new OptionMapError("映射不能为空");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new OptionMapError(
      `不是合法 JSON：${error instanceof Error ? error.message : String(error)}。` +
        `要写双引号键，例如 {"max_completion_tokens": "{{maxOutputTokens}}"}`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new OptionMapError("映射必须是一个 JSON 对象，或一个规则数组");
  }
  if (Array.isArray(parsed)) {
    parsed.forEach((rule, index) => {
      if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
        throw new OptionMapError(`第 ${index + 1} 条规则不是对象`);
      }
      const record = rule as Record<string, unknown>;
      if (!Object.hasOwn(record, "set")) {
        throw new OptionMapError(`第 ${index + 1} 条规则缺 "set"（它要合并什么）`);
      }
    });
  }
  return parsed as OptionMapSpec;
}

/** 把占位符换成值。值缺失时**抛错**（静默留空会把 `""` 发出去）。 */
function fillPlaceholders(value: JsonValue, values: OptionValues): JsonValue {
  if (typeof value === "string") {
    /* 整个字符串就是一个占位符时，保留原始类型（数字不会被变成字符串） */
    const whole = /^\{\{\s*(reasoningLevel|maxOutputTokens)\s*\}\}$/.exec(value.trim());
    if (whole) return resolvePlaceholder(whole[1]!, values);
    return value.replace(PLACEHOLDER, (_match, name: string) => String(resolvePlaceholder(name, values)));
  }
  if (Array.isArray(value)) return value.map((entry) => fillPlaceholders(entry, values));
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) out[key] = fillPlaceholders(entry, values);
    return out;
  }
  return value;
}

function resolvePlaceholder(name: string, values: OptionValues): JsonValue {
  if (name === "reasoningLevel") {
    if (values.reasoningLevel === undefined) {
      throw new OptionMapError("映射里用了 {{reasoningLevel}}，但这一轮没有选推理档位");
    }
    return values.reasoningLevel;
  }
  if (values.maxOutputTokens === undefined) {
    throw new OptionMapError("映射里用了 {{maxOutputTokens}}，但模型没有声明最大输出上限");
  }
  return values.maxOutputTokens;
}

/** 规则是否命中。 */
export function ruleHits(rule: OptionMapRule, values: OptionValues): boolean {
  const when = rule.when;
  if (!when) return true;
  if (when.reasoningLevel !== undefined && when.reasoningLevel !== values.reasoningLevel) return false;
  if (when.maxOutputTokensMin !== undefined) {
    if (typeof values.maxOutputTokens !== "number") return false;
    if (values.maxOutputTokens < when.maxOutputTokensMin) return false;
  }
  return true;
}

/**
 * 求值：把声明 + 本轮的值变成**要合并进请求体的补丁**。
 *
 * @param spec 声明
 * @param values 本轮的值
 * @returns 补丁对象（已填好占位符）
 */
export function evaluateOptionMap(spec: OptionMapSpec, values: OptionValues): { [key: string]: JsonValue } {
  if (Array.isArray(spec)) {
    const hit = spec.find((rule) => ruleHits(rule, values));
    if (!hit) return {};
    if (hit.set === null || typeof hit.set !== "object" || Array.isArray(hit.set)) {
      throw new OptionMapError("命中规则的 \"set\" 必须是 JSON 对象");
    }
    return fillPlaceholders(hit.set, values) as { [key: string]: JsonValue };
  }
  return fillPlaceholders(spec, values) as { [key: string]: JsonValue };
}

/** 递归找补丁里的键路径（用于保留键检查与"会改什么"的预览）。 */
function collectPaths(patch: { [key: string]: JsonValue }, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = [...prefix, key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = collectPaths(value as { [key: string]: JsonValue }, path);
      if (nested.length) out.push(...nested);
      else out.push(path);
    } else {
      out.push(path);
    }
  }
  return out;
}

/**
 * 检查补丁有没有碰保留键。
 *
 * @returns 第一个被碰的键（`null` = 干净）
 */
export function reservedKeyIn(patch: { [key: string]: JsonValue }): string | null {
  for (const path of collectPaths(patch)) {
    const head = path[0];
    if (head !== undefined && (RESERVED_KEYS as readonly string[]).includes(head)) return head;
  }
  return null;
}

/**
 * RFC 7396 JSON Merge Patch。
 *
 * 语义照标准：`null` 删键；两边都是对象则递归；其余整体替换（数组不合并）。
 *
 * @param target 原对象
 * @param patch 补丁
 */
export function mergePatch(
  target: { [key: string]: JsonValue },
  patch: { [key: string]: JsonValue },
): { [key: string]: JsonValue } {
  const result: { [key: string]: JsonValue } = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    const current = result[key];
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      result[key] = mergePatch(current as { [key: string]: JsonValue }, value as { [key: string]: JsonValue });
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** 一次应用的结果（`changed` 给界面显示"这一轮会改什么"）。 */
export type OptionMapApplication = {
  patch: { [key: string]: JsonValue };
  changed: string[];
};

/**
 * 应用：求值 → 检查保留键 → 合并。
 *
 * @param spec 声明
 * @param values 本轮的值
 * @param body 原请求体（不给就只返回补丁）
 * @returns 补丁、变更路径、合并后的 body
 */
export function applyOptionMap(
  spec: OptionMapSpec,
  values: OptionValues,
  body?: { [key: string]: JsonValue },
): OptionMapApplication & { body?: { [key: string]: JsonValue } } {
  const patch = evaluateOptionMap(spec, values);
  const reserved = reservedKeyIn(patch);
  if (reserved) {
    throw new OptionMapError(
      `映射想改保留键 "${reserved}"：它会把请求结构改坏，不允许。映射只该改参数名与取值`,
    );
  }
  const changed = collectPaths(patch).map((path) => path.join("."));
  return {
    patch,
    changed,
    ...(body === undefined ? {} : { body: mergePatch(body, patch) }),
  };
}

/**
 * 保存前校验（CLI 与界面共用）。
 *
 * @param text 用户输入的文本
 * @param values 拿一组样例值试算（缺省时用占位值）
 * @returns 错误消息（`null` = 通过）
 */
export function validateOptionMap(text: string, values: OptionValues = {}): string | null {
  try {
    const spec = parseOptionMap(text);
    /*
     * 试算用"占位值"：用户可能还没声明输出上限，但映射本身得先能编译出来。
     * 这一步只验**形状与保留键**，不验"这一轮有没有值"（那是运行时的事）。
     */
    const result = applyOptionMap(spec, {
      reasoningLevel: values.reasoningLevel ?? "high",
      maxOutputTokens: values.maxOutputTokens ?? 1024,
    });
    if (!result.changed.length) return "映射解析出来是空的：它什么都不会改";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 给人看的一句摘要（列表/表单里显示"这条映射会把什么改成什么"）。 */
export function describeOptionMap(text: string, values: OptionValues = {}): string {
  try {
    const result = applyOptionMap(parseOptionMap(text), {
      reasoningLevel: values.reasoningLevel ?? "high",
      maxOutputTokens: values.maxOutputTokens ?? 1024,
    });
    return result.changed.length ? `写入 ${result.changed.join("、")}` : "什么都不会改";
  } catch (error) {
    return `无法解析：${error instanceof Error ? error.message : String(error)}`;
  }
}
