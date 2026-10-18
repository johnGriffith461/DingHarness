import { describe, expect, it } from "vitest";

import {
  overlayPatch,
  overlayValue,
  resolveModelConfig,
  ruleMatches,
  validateOptionMap,
  type ModelConfigRule,
} from "./modelConfig";

/**
 * 模型能力表单的**解析语义**（T0）。
 *
 * 这里守的是四件很容易"看起来对、实际错"的事：
 * 1. `undefined` = 继承、`null` = 清空（这两者混了，"跟随推荐"就永远失效）；
 * 2. 规则顺序（宽泛 → 精确），写反会让用户的手动值被推荐覆盖；
 * 3. `modelMatch` 是**整串锚定**（`flash` 不该匹配到 `deepseek-flash-1017`）；
 * 4. 参数映射的保留键（映射只改参数名，不改请求结构）。
 */

describe("稀疏覆盖：undefined 继承 / null 清空", () => {
  it("undefined 不覆盖，null 落成 null，普通值直接替换", () => {
    expect(overlayValue({ a: 1, b: 2 }, { a: undefined, b: 3 })).toEqual({ a: 1, b: 3 });
    expect(overlayValue({ a: 1, b: 2 }, { a: null })).toEqual({ a: null, b: 2 });
  });

  it("对象逐字段递归，不会整块替换掉兄弟字段", () => {
    const base = { properties: { contextWindow: 1_000_000, supportsToolCall: true } };
    const patch = { properties: { contextWindow: 200_000 } };
    expect(overlayPatch(base as never, patch as never)).toEqual({
      properties: { contextWindow: 200_000, supportsToolCall: true },
    });
  });

  it("数组整体替换（不做元素级合并：删掉一个档位不该变成猜谜）", () => {
    const merged = overlayValue({ values: ["low", "medium", "high"] }, { values: ["low"] });
    expect(merged).toEqual({ values: ["low"] });
  });
});

describe("规则匹配", () => {
  const base = { providerId: "tokenrhythm", modelId: "deepseek-v4.1-flash-1017", baseUrl: "https://x/v1/" };

  it("model 规则是整串锚定：`flash` 不匹配 `deepseek-v4.1-flash-1017`", () => {
    expect(ruleMatches({ type: "model", modelMatch: "flash", config: {} }, base)).toBe(false);
    expect(
      ruleMatches({ type: "model", modelMatch: "deepseek-v4\\.1-flash-1017", config: {} }, base),
    ).toBe(true);
  });

  it("provider-site 匹配前会去掉 baseUrl 尾斜杠", () => {
    expect(
      ruleMatches(
        { type: "provider-site", modelMatch: ".*", baseUrlMatch: "https://x/v1", config: {} },
        base,
      ),
    ).toBe(true);
  });

  it("坏正则不匹配任何东西（宁可漏一条推荐，也不要匹配到全部）", () => {
    expect(ruleMatches({ type: "model", modelMatch: "([", config: {} }, base)).toBe(false);
  });

  it("exact 认 provider+model 两个都相等", () => {
    expect(
      ruleMatches({ type: "exact", providerId: "tokenrhythm", modelId: base.modelId, config: {}, manual: true }, base),
    ).toBe(true);
    expect(
      ruleMatches({ type: "exact", providerId: "other", modelId: base.modelId, config: {}, manual: true }, base),
    ).toBe(false);
  });
});

describe("解析顺序：宽泛 → 精确", () => {
  const input = { providerId: "p", modelId: "m", baseUrl: "https://h/v1" };

  it("exact 覆盖 provider-site，provider-site 覆盖 model", () => {
    const rules: ModelConfigRule[] = [
      { type: "model", modelMatch: "m", config: { properties: { contextWindow: 100 } } },
      { type: "provider-site", modelMatch: ".*", baseUrlMatch: "https://h/v1", config: { properties: { contextWindow: 200 } } },
      { type: "exact", providerId: "p", modelId: "m", config: { properties: { contextWindow: 300 } }, manual: true },
    ];
    const resolved = resolveModelConfig(rules, input);
    expect(resolved.contextWindow).toBe(300);
    expect(resolved.manual).toBe(true);
  });

  it("手动规则只覆盖自己给的字段，其余仍跟随推荐", () => {
    const rules: ModelConfigRule[] = [
      {
        type: "model",
        modelMatch: "m",
        config: { properties: { contextWindow: 100, supportsToolCall: true } },
      },
      { type: "exact", providerId: "p", modelId: "m", config: { properties: { contextWindow: 200 } }, manual: true },
    ];
    const resolved = resolveModelConfig(rules, input);
    expect(resolved.contextWindow).toBe(200);
    expect(resolved.supportsToolCall).toBe(true); // 没被手动规则清掉
  });

  it("规则在数组里的先后不影响结果（顺序由类型决定）", () => {
    const exact: ModelConfigRule = {
      type: "exact",
      providerId: "p",
      modelId: "m",
      config: { properties: { contextWindow: 200 } },
      manual: true,
    };
    const model: ModelConfigRule = { type: "model", modelMatch: "m", config: { properties: { contextWindow: 100 } } };
    expect(resolveModelConfig([exact, model], input).contextWindow).toBe(200);
    expect(resolveModelConfig([model, exact], input).contextWindow).toBe(200);
  });
});

describe("扁平视图的默认值", () => {
  const input = { providerId: "p", modelId: "m" };

  it("没有任何规则：窗口/输出未声明，文本输入恒真", () => {
    const resolved = resolveModelConfig([], input);
    expect(resolved.contextWindow).toBeUndefined();
    expect(resolved.maxOutputTokens).toBeUndefined();
    expect(resolved.inputFormat.supportsText).toBe(true);
    expect(resolved.inputFormat.supportsImage).toBe(false);
    expect(resolved.matched).toEqual([]);
    expect(resolved.manual).toBe(false);
  });

  it("null 清空必填项等于「未声明」（不是 0）", () => {
    const resolved = resolveModelConfig(
      [{ type: "model", modelMatch: "m", config: { properties: { contextWindow: null } } }],
      input,
    );
    expect(resolved.contextWindow).toBeUndefined();
  });

  it("非正数的窗口按未声明处理（0 / 负数不该被当成有效窗口）", () => {
    for (const bad of [0, -1]) {
      const resolved = resolveModelConfig(
        [{ type: "model", modelMatch: "m", config: { properties: { contextWindow: bad } } }],
        input,
      );
      expect(resolved.contextWindow).toBeUndefined();
    }
  });
});

describe("参数映射的校验（声明式，不是表达式语言）", () => {
  it("合法的对象映射通过", () => {
    expect(validateOptionMap('{"max_completion_tokens": "{{maxOutputTokens}}"}')).toBeNull();
  });

  it("规则表通过，且条件分支能写", () => {
    const text = JSON.stringify([
      { when: { reasoningLevel: "high" }, set: { reasoning: { effort: "high" } } },
      { set: { reasoning: { effort: "low" } } },
    ]);
    expect(validateOptionMap(text)).toBeNull();
  });

  it("不是 JSON 时给出可执行的提示（要写成双引号键）", () => {
    const error = validateOptionMap("{'a': 1}");
    expect(error).toContain("不是合法 JSON");
    expect(error).toContain("双引号");
  });

  it("碰保留键就拒绝保存（映射只改参数名，不改请求结构）", () => {
    expect(validateOptionMap('{"messages": []}')).toContain("保留键");
    expect(validateOptionMap('{"tools": {}}')).toContain("保留键");
    expect(validateOptionMap('{"model": "x"}')).toContain("保留键");
  });

  it("解析出来是空的也拒绝（写了等于没写，要告诉用户）", () => {
    expect(validateOptionMap("{}")).toContain("什么都不会改");
  });

  it("规则表缺 set 时报出第几条", () => {
    expect(validateOptionMap('[{"when": {}}]')).toContain("第 1 条");
  });
});
