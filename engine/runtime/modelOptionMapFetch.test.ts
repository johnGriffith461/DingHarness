import { describe, expect, it } from "vitest";

import { createModelOptionMapFetch, optionValuesOf } from "./modelOptionMapFetch";
import type { JsonValue } from "./modelOptionMap";

/**
 * 请求体改写（T0）。
 *
 * 这里测的是**真的会被发出去的那份 body** —— 不是"我们以为改了"。
 * 用假 fetch 捕获，断言字段与类型都对。
 */

const VALUES = { reasoningLevel: "high", maxOutputTokens: 32_000 };

/** 造一个假 fetch：记下最后一次请求体，返回一个空响应。 */
function fakeFetch(): {
  fetch: typeof globalThis.fetch;
  lastBody: () => Record<string, JsonValue> | undefined;
  calls: () => number;
} {
  let body: Record<string, JsonValue> | undefined;
  let calls = 0;
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    /* 只解析字符串 body：FormData / Blob 那条路本来就不该被映射，别在夹具里自己炸 */
    body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, JsonValue>) : undefined;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: impl, lastBody: () => body, calls: () => calls };
}

const original = { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 100 };

describe("没有映射时零开销", () => {
  it("两条都空 → 返回原 fetch（同一个函数引用）", () => {
    const { fetch } = fakeFetch();
    const wrapped = createModelOptionMapFetch({ fetch, specs: {}, values: VALUES });
    expect(wrapped).toBe(fetch);
  });
});

describe("改字段名", () => {
  it("把 max_tokens 映射成 max_completion_tokens（中转站常见要求）", async () => {
    const { fetch, lastBody } = fakeFetch();
    const wrapped = createModelOptionMapFetch({
      fetch,
      specs: { maxOutputTokens: '{"max_completion_tokens": "{{maxOutputTokens}}"}' },
      values: VALUES,
    });
    await wrapped("https://example/v1", { method: "POST", body: JSON.stringify(original) });
    expect(lastBody()).toMatchObject({ max_completion_tokens: 32_000 });
    expect(typeof lastBody()!.max_completion_tokens).toBe("number");
    // 原字段不被删（映射是"补"，不是"换"）
    expect(lastBody()).toMatchObject({ max_tokens: 100 });
  });

  it("推理档位写进嵌套对象", async () => {
    const { fetch, lastBody } = fakeFetch();
    const wrapped = createModelOptionMapFetch({
      fetch,
      specs: { reasoningLevel: '{"reasoning": {"effort": "{{reasoningLevel}}"}}' },
      values: VALUES,
    });
    await wrapped("https://example/v1", { method: "POST", body: JSON.stringify(original) });
    expect(lastBody()).toMatchObject({ reasoning: { effort: "high" } });
  });

  it("两条映射按顺序合并（后者可覆盖前者同名键）", async () => {
    const { fetch, lastBody } = fakeFetch();
    const wrapped = createModelOptionMapFetch({
      fetch,
      specs: {
        reasoningLevel: '{"meta": {"from": "reasoning"}}',
        maxOutputTokens: '{"meta": {"from": "output"}}',
      },
      values: VALUES,
    });
    await wrapped("https://example/v1", { method: "POST", body: JSON.stringify(original) });
    expect(lastBody()).toMatchObject({ meta: { from: "output" } });
  });

  it("capture 拿到改写后的 body 与变更路径（验收脚本用它取证）", async () => {
    const { fetch } = fakeFetch();
    const seen: string[] = [];
    const wrapped = createModelOptionMapFetch({
      fetch,
      specs: { maxOutputTokens: '{"max_tokens": "{{maxOutputTokens}}"}' },
      values: VALUES,
      capture: (_body, changed) => seen.push(...changed),
    });
    await wrapped("https://example/v1", { method: "POST", body: JSON.stringify(original) });
    expect(seen).toEqual(["max_tokens"]);
  });
});

describe("fail-closed", () => {
  it("请求体不是 JSON 时抛错（不假装映射生效）", async () => {
    const { fetch } = fakeFetch();
    const wrapped = createModelOptionMapFetch({
      fetch,
      specs: { maxOutputTokens: '{"max_tokens": "{{maxOutputTokens}}"}' },
      values: VALUES,
    });
    await expect(wrapped("https://example/v1", { method: "POST", body: "not json" })).rejects.toThrow(
      /不是 JSON/,
    );
  });

  it("请求体是 JSON 数组时也抛（只接受对象）", async () => {
    const { fetch } = fakeFetch();
    const wrapped = createModelOptionMapFetch({
      fetch,
      specs: { maxOutputTokens: '{"max_tokens": 1}' },
      values: VALUES,
    });
    await expect(wrapped("https://example/v1", { method: "POST", body: "[1,2]" })).rejects.toThrow(/不是 JSON 对象/);
  });

  it("非 JSON 请求（FormData）直接放过，不改也不报错", async () => {
    const { fetch, calls } = fakeFetch();
    const wrapped = createModelOptionMapFetch({
      fetch,
      specs: { maxOutputTokens: '{"max_tokens": 1}' },
      values: VALUES,
    });
    const form = new FormData();
    await wrapped("https://example/v1", { method: "POST", body: form });
    expect(calls()).toBe(1);
  });

  it("映射要的值缺失时抛错（不能把空串发出去）", async () => {
    const { fetch } = fakeFetch();
    const wrapped = createModelOptionMapFetch({
      fetch,
      specs: { reasoningLevel: '{"effort": "{{reasoningLevel}}"}' },
      values: {}, // 没选档位
    });
    await expect(wrapped("https://example/v1", { method: "POST", body: JSON.stringify(original) })).rejects.toThrow(
      /reasoningLevel/,
    );
  });
});

describe("optionValuesOf", () => {
  it("没选档位/没声明输出时不带这两个键（映射里用到才报错）", () => {
    expect(optionValuesOf({})).toEqual({});
  });

  it("正常值原样带上", () => {
    expect(optionValuesOf({ reasoningLevel: "high", maxOutputTokens: 1024 })).toEqual({
      reasoningLevel: "high",
      maxOutputTokens: 1024,
    });
  });

  it("0 或负数不当成有效输出上限", () => {
    expect(optionValuesOf({ maxOutputTokens: 0 })).toEqual({});
    expect(optionValuesOf({ maxOutputTokens: -5 })).toEqual({});
  });
});
