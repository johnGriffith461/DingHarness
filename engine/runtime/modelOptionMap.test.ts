import { describe, expect, it } from "vitest";

import {
  RESERVED_KEYS,
  applyOptionMap,
  describeOptionMap,
  evaluateOptionMap,
  mergePatch,
  parseOptionMap,
  reservedKeyIn,
  ruleHits,
  type OptionMapRule,
} from "./modelOptionMap";

/**
 * **声明式参数映射**（T0）。
 *
 * 守两件事：映射真的能改字段名/取值；以及它**改不了**请求结构。
 * 后者是安全边界，不是功能 —— 一个能改 `messages` 的映射等于把整轮对话换掉。
 */

const VALUES = { reasoningLevel: "high", maxOutputTokens: 32_000 };

describe("占位符替换", () => {
  it("字符串整个是占位符时保留原始类型（数字不变成字符串）", () => {
    const patch = evaluateOptionMap({ max_tokens: "{{maxOutputTokens}}" }, VALUES);
    expect(patch).toEqual({ max_tokens: 32_000 });
    expect(typeof patch.max_tokens).toBe("number");
  });

  it("嵌在字符串里的占位符按文本替换", () => {
    expect(evaluateOptionMap({ note: "level={{reasoningLevel}}" }, VALUES)).toEqual({ note: "level=high" });
  });

  it("嵌套对象/数组里的占位符也能替换", () => {
    const patch = evaluateOptionMap(
      { reasoning: { effort: "{{reasoningLevel}}" }, tags: ["{{reasoningLevel}}", 1] },
      VALUES,
    );
    expect(patch).toEqual({ reasoning: { effort: "high" }, tags: ["high", 1] });
  });

  it("用了占位符但这轮没有值 → 报错，而不是把空串发出去", () => {
    expect(() => evaluateOptionMap({ max_tokens: "{{maxOutputTokens}}" }, {})).toThrow(/maxOutputTokens/);
    expect(() => evaluateOptionMap({ effort: "{{reasoningLevel}}" }, { maxOutputTokens: 1 })).toThrow(
      /reasoningLevel/,
    );
  });
});

describe("规则表：从上往下第一个命中的生效", () => {
  const spec = [
    { when: { reasoningLevel: "high" }, set: { verbosity: "high" } },
    { when: { maxOutputTokensMin: 10_000 }, set: { verbosity: "long" } },
    { set: { verbosity: "default" } },
  ];

  it("命中第一条就不再往下看", () => {
    expect(evaluateOptionMap(spec, { reasoningLevel: "high", maxOutputTokens: 50_000 })).toEqual({
      verbosity: "high",
    });
  });

  it("第一条不中时看下一条", () => {
    expect(evaluateOptionMap(spec, { reasoningLevel: "low", maxOutputTokens: 50_000 })).toEqual({
      verbosity: "long",
    });
  });

  it("都不中时走无条件的兜底", () => {
    expect(evaluateOptionMap(spec, { reasoningLevel: "low", maxOutputTokens: 100 })).toEqual({
      verbosity: "default",
    });
  });

  it("没有兜底且都不中 → 空补丁（等于不改）", () => {
    expect(evaluateOptionMap([{ when: { reasoningLevel: "high" }, set: { a: 1 } }], {})).toEqual({});
  });

  it("when 的两个条件都满足才算命中", () => {
    expect(ruleHits({ when: { reasoningLevel: "high", maxOutputTokensMin: 10_000 }, set: {} }, VALUES)).toBe(true);
    expect(
      ruleHits({ when: { reasoningLevel: "high", maxOutputTokensMin: 100_000 }, set: {} }, VALUES),
    ).toBe(false);
  });
});

describe("RFC 7396 合并", () => {
  it("null 删键、对象递归、其余整体替换", () => {
    expect(
      mergePatch(
        { a: 1, b: { c: 2, d: 3 }, e: [1, 2] },
        { a: null, b: { c: 9 }, e: [3] } as never,
      ),
    ).toEqual({ b: { c: 9, d: 3 }, e: [3] });
  });

  it("数组整体替换，不合并元素", () => {
    expect(mergePatch({ tags: [1, 2, 3] }, { tags: [9] } as never)).toEqual({ tags: [9] });
  });
});

describe("安全边界：映射碰不了请求结构", () => {
  it("保留键清单是这套边界的一处定义", () => {
    expect([...RESERVED_KEYS].sort()).toEqual(["input", "messages", "model", "stream", "system", "tools"]);
  });

  it("顶层保留键被拒", () => {
    for (const key of RESERVED_KEYS) {
      expect(reservedKeyIn({ [key]: {} })).toBe(key);
      expect(() => applyOptionMap({ [key]: {} }, VALUES)).toThrow(/保留键/);
    }
  });

  it("嵌套在自定义键下的同名键**不拦**（那是数据，不是结构）", () => {
    /*
     * `{metadata: {messages: [...]}}` 只是往请求体里加一个新字段 metadata，
     * 它**碰不到**真正的 `messages`。拦它属于误伤：有人确实要传自己的元数据。
     * 只有**顶层**保留键才改得动请求结构。
     */
    expect(reservedKeyIn({ metadata: { messages: ["hi"] } } as never)).toBeNull();
    expect(() => applyOptionMap({ metadata: { messages: ["hi"] } } as never, VALUES)).not.toThrow();
  });

  it("改参数名不受影响（这是它该做的事）", () => {
    expect(() => applyOptionMap({ max_completion_tokens: "{{maxOutputTokens}}" }, VALUES)).not.toThrow();
  });
});

describe("解析与摘要", () => {
  it("非 JSON 报可执行的错", () => {
    expect(() => parseOptionMap("max_tokens: 100")).toThrow(/不是合法 JSON/);
  });

  it("空串报错", () => {
    expect(() => parseOptionMap("   ")).toThrow(/不能为空/);
  });

  it("摘要说清会写入哪些键", () => {
    expect(describeOptionMap('{"max_tokens": "{{maxOutputTokens}}"}')).toContain("max_tokens");
  });

  it("摘要对不可解析的映射给出原因", () => {
    expect(describeOptionMap("{bad")).toContain("无法解析");
  });
});

describe("端到端：改字段名 + 按档位分支", () => {
  it("中转站要 max_completion_tokens 时，映射把请求体改写对", () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 100 };
    const result = applyOptionMap({ max_completion_tokens: "{{maxOutputTokens}}" }, VALUES, body as never);
    expect(result.body).toMatchObject({ max_completion_tokens: 32_000, max_tokens: 100 });
    expect(result.changed).toEqual(["max_completion_tokens"]);
  });

  it("Anthropic 风格的 reasoning 分支：high 档发 effort=high 且带 verbosity", () => {
    const spec: OptionMapRule[] = [
      { when: { reasoningLevel: "high" }, set: { reasoning: { effort: "high" }, verbosity: "high" } },
      { set: { reasoning: { effort: "low" } } },
    ];
    expect(evaluateOptionMap(spec, { reasoningLevel: "high" })).toEqual({
      reasoning: { effort: "high" },
      verbosity: "high",
    });
    expect(evaluateOptionMap(spec, { reasoningLevel: "low" })).toEqual({ reasoning: { effort: "low" } });
  });
});
