import { describe, expect, it } from "vitest";

import { modelFormOrder, reasoningRowVisible } from "./modelForm";
import { prefillFor } from "./modelPrefill";

/**
 * M-04：表单顺序与自动预填。
 *
 * 顺序是主人点名的；预填的判据是"来源可见" —— 目录/端点/默认 三档文案不能混。
 */
describe("表单字段顺序", () => {
  it("⭐ 模型 → 上下文 → 输出 → 输入类型 → 思考强度", () => {
    expect(modelFormOrder()).toEqual(["model", "contextWindow", "maxOutput", "inputModalities", "reasoningEffort"]);
  });

  it("返回新数组（调用方改它不影响下一次）", () => {
    const first = modelFormOrder();
    first.reverse();
    expect(modelFormOrder()[0]).toBe("model");
  });
});

describe("思考强度那一行", () => {
  it("reasoning=false 时整行不出现（不是禁用）", () => {
    expect(reasoningRowVisible({ reasoning: false })).toBe(false);
    expect(reasoningRowVisible({})).toBe(false);
    expect(reasoningRowVisible(undefined)).toBe(false);
  });

  it("reasoning=true 才出现", () => {
    expect(reasoningRowVisible({ reasoning: true })).toBe(true);
  });
});

describe("自动预填", () => {
  it("目录命中：带出窗口与输出，来源是模型目录", () => {
    const got = prefillFor("deepseek", "deepseek-chat");
    expect(got?.contextWindow).toBeGreaterThan(100_000);
    expect(got?.source).toBe("catalog");
    expect(got?.label).toContain("模型目录");
  });

  it("只有端点数据：来源是端点返回", () => {
    const got = prefillFor("myrelay", "some-model", { contextWindow: 128_000, maxOutput: 8_000 });
    expect(got?.source).toBe("endpoint");
    expect(got?.label).toContain("端点");
  });

  it("都没有：默认值 + 明确说「未登记，请核对」", () => {
    const got = prefillFor("myrelay", "unknown-xyz");
    expect(got?.source).toBe("default");
    expect(got?.label).toContain("未登记");
  });

  it("用户改过：来源文案变成「已手动修改」", () => {
    const got = prefillFor("deepseek", "deepseek-chat", undefined, undefined, true);
    expect(got?.label).toBe("已手动修改");
  });

  it("空模型名不预填（返回 null，别把 200k 硬塞进空表单）", () => {
    expect(prefillFor("deepseek", "   ")).toBeNull();
  });
});
