import {
  applyOptionMap,
  parseOptionMap,
  type JsonValue,
  type OptionMapSpec,
  type OptionValues,
} from "./modelOptionMap";

/**
 * **请求体改写**（T0）：把参数映射真的落到 HTTP body 上。
 *
 * ## 为什么改 body 而不是 `providerOptions`
 *
 * `providerOptions` 是 SDK 的扩展点，但**每家认的键不一样**，中转站还会再改一次
 * （`max_tokens` / `max_completion_tokens` 都见过）。只靠 SDK 选项我们永远在追各家实现；
 * 改最终 body 是**一个位置管所有家**。
 *
 * ## fail-closed
 *
 * body 不是 JSON 对象时**抛错**，不原样放过去：
 * 不动它等于"用户以为映射生效了、其实没生效"，这比报错难查得多。
 */

/** 建一个会改写请求体的 fetch。没有映射时返回原 fetch（零开销）。 */
export function createModelOptionMapFetch(options: {
  fetch: typeof globalThis.fetch;
  /** 用户写的映射文本（两条：推理档位、输出上限）。空串 = 不映射那一项。 */
  specs: { reasoningLevel?: string; maxOutputTokens?: string };
  /** 本轮的值。 */
  values: OptionValues;
  /** 测试用：拿到改写后的 body 与变更路径。 */
  capture?: (body: { [key: string]: JsonValue }, changed: string[]) => void;
}): typeof globalThis.fetch {
  const compiled = compileSpecs(options.specs);
  if (!compiled.length) return options.fetch;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const text = await readBodyText(input, init);
    /* 非 JSON 请求（FormData/Blob/流）本来就不该映射：直接放过 */
    if (text === null) return options.fetch(input as RequestInfo, init);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        "请求体不是 JSON，参数映射无法应用（fail-closed：宁可报错，也不假装映射生效了）",
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("请求体不是 JSON 对象，参数映射无法应用");
    }

    let body = parsed as { [key: string]: JsonValue };
    const changed: string[] = [];
    for (const spec of compiled) {
      const result = applyOptionMap(spec, options.values, body);
      body = result.body!;
      changed.push(...result.changed);
    }
    options.capture?.(body, changed);
    return options.fetch(input as RequestInfo, { ...(init ?? {}), body: JSON.stringify(body) });
  };
}

/** 编译两条映射（解析一次，请求时只求值）。解析失败在这一刻就炸，不留到发请求时。 */
function compileSpecs(specs: { reasoningLevel?: string; maxOutputTokens?: string }): OptionMapSpec[] {
  const out: OptionMapSpec[] = [];
  for (const text of [specs.reasoningLevel, specs.maxOutputTokens]) {
    if (typeof text !== "string" || !text.trim()) continue;
    out.push(parseOptionMap(text));
  }
  return out;
}

/**
 * 读出请求体文本。
 *
 * @returns 文本；**不是 JSON 请求**时返回 `null`（调用方据此跳过改写）
 */
async function readBodyText(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | null> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body !== undefined && body !== null) return null; // FormData / Blob / 流
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 把"要映射的值"收窄成映射程序吃的形态。
 *
 * 没选就不映射（不传这一项）—— 映射一个空串会把 `effort: ""` 发出去。
 */
export function optionValuesOf(input: {
  reasoningLevel?: string;
  maxOutputTokens?: number;
}): OptionValues {
  return {
    ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel } : {}),
    ...(typeof input.maxOutputTokens === "number" && input.maxOutputTokens > 0
      ? { maxOutputTokens: input.maxOutputTokens }
      : {}),
  };
}
