import { describe, expect, it } from "vitest";

import { resolveCapability, sourceLabel } from "./modelCapability";
import { canonicalModelId, trimOpenRouterModels } from "./modelSnapshot";

/**
 * M-07：能力的三级来源（用户 > 端点 > 目录 > 默认）。
 *
 * 判据只有一条：**不许拿"看起来合理"的数字冒充事实**。
 * 目录命中就带出来源，没命中就明确标 `default`，用户才不会把 200k 当成真规格。
 */
describe("能力解析", () => {
  it("⭐ 用户显式声明最优先（连目录都不看）", () => {
    const got = resolveCapability({
      providerId: "deepseek",
      modelId: "deepseek-chat",
      declared: { contextWindow: 64_000, maxOutput: 4_000 },
    });
    expect(got.contextWindow).toBe(64_000);
    expect(got.maxOutput).toBe(4_000);
    expect(got.source).toBe("user");
    expect(got.sources.maxOutput).toBe("user");
  });

  it("端点自报压过目录（本家说自己多少就是多少）", () => {
    const got = resolveCapability({
      providerId: "myrelay",
      modelId: "deepseek-chat",
      fetched: { contextWindow: 128_000, maxOutput: 8_000 },
    });
    expect(got.contextWindow).toBe(128_000);
    expect(got.maxOutput).toBe(8_000);
    expect(got.source).toBe("endpoint");
  });

  it("目录命中：窗口 + 输出上限都带出来（快照补上手核缺的 maxOutput）", () => {
    const got = resolveCapability({ providerId: "deepseek", modelId: "deepseek-chat" });
    expect(got.contextWindow).toBeGreaterThan(100_000);
    expect(got.maxOutput).toBeGreaterThan(0);
    expect(got.maxOutput).not.toBe(32_000);
    expect(got.source).toBe("catalog");
    expect(got.catalogMatch?.id).toBe("deepseek-chat");
  });

  it("目录里的视觉能力也能带出来", () => {
    const got = resolveCapability({ providerId: "openai", modelId: "gpt-4o-mini" });
    expect(got.inputModalities).toContain("image");
    expect(got.source).toBe("catalog");
  });

  it("归一化匹配：带 vendor 前缀的中转模型名也能命中目录", () => {
    const got = resolveCapability({ providerId: "myrelay", modelId: "anthropic/claude-sonnet-4.5" });
    expect(got.source).toBe("catalog");
    expect(canonicalModelId("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
  });

  it("⭐ 没登记 → 默认值 + source=default（界面会说「请核对」）", () => {
    const got = resolveCapability({ providerId: "myrelay", modelId: "totally-unknown-model-xyz" });
    expect(got.contextWindow).toBe(200_000);
    expect(got.maxOutput).toBe(32_000);
    expect(got.source).toBe("default");
    expect(sourceLabel(got.source)).toContain("未登记");
  });

  it("来源文案四档各不相同", () => {
    const labels = [
      sourceLabel("user"),
      sourceLabel("endpoint"),
      sourceLabel("catalog"),
      sourceLabel("default"),
      sourceLabel("catalog", { edited: true }),
    ];
    expect(new Set(labels).size).toBe(5);
  });
});

describe("快照裁剪", () => {
  it("只留需要的字段（无关的描述/排行榜不进仓库）", () => {
    const got = trimOpenRouterModels({
      data: [
        {
          id: "vendor/model-a",
          name: "Model A",
          description: "很长的描述不该进仓库",
          context_length: 128000,
          top_provider: { max_completion_tokens: 8192 },
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          supported_parameters: ["tools"],
          pricing: { prompt: "0.000001", completion: "0.000002" },
          per_request_limits: { nonsense: true },
        },
      ],
    });
    expect(got).toHaveLength(1);
    expect(Object.keys(got[0]!).sort()).toEqual(
      ["canonical_model_id", "cost", "id", "limit", "modalities", "name", "provider", "reasoning", "tool_call"].sort(),
    );
    expect(got[0]!.limit).toEqual({ context: 128000, output: 8192 });
    expect(got[0]!.modalities.input).toEqual(["text", "image"]);
    expect(got[0]!.cost).toEqual({ in: 1, out: 2 });
    expect(JSON.stringify(got)).not.toContain("很长的描述");
  });

  it("没有 id / 没有窗口的条目丢掉（匹配不了的东西不占位）", () => {
    const got = trimOpenRouterModels({ data: [{ name: "no id" }, { id: "x/no-context" }] });
    expect(got).toEqual([]);
  });
});
