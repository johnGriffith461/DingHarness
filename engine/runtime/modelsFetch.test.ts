import { describe, expect, it } from "vitest";

import { modelCapsFromJson, modelIdsFromJson, modelsUrlFor } from "./modelsFetch";

/**
 * 拉取模型清单（2026-10-16）—— 钉两件纯逻辑：**响应怎么解析**与**地址怎么拼**。
 *
 * 网络那半在主进程（`electron/ipc/ai.ts`），不在这里测；这里测的是"拿到响应之后"
 * —— 而那正是各家形状不一样、最容易猜错的地方。
 */
describe("拉取模型清单", () => {
  it("OpenAI 形状：data[].id", () => {
    const got = modelIdsFromJson({ object: "list", data: [{ id: "gpt-4o-mini" }, { id: "o3" }] });
    expect(got).toEqual(["gpt-4o-mini", "o3"]);
  });

  it("中转的两种简化形状：models 是字符串数组 / 对象数组", () => {
    expect(modelIdsFromJson({ models: ["deepseek-chat", "qwen-plus"] })).toEqual(["deepseek-chat", "qwen-plus"]);
    expect(modelIdsFromJson({ models: [{ id: "glm-4" }, { name: "kimi" }] })).toEqual(["glm-4", "kimi"]);
  });

  it("去重 + 排序 + 剔空（重复名字各家都有）", () => {
    expect(modelIdsFromJson({ data: [{ id: "b" }, { id: "a" }, { id: "a" }, { id: "  " }] })).toEqual(["a", "b"]);
  });

  it("⭐ 认不出来就返回空数组 —— **不猜**（别拿 baseURL 编一个模型名出来）", () => {
    expect(modelIdsFromJson({ error: { message: "无效的 key" } })).toEqual([]);
    expect(modelIdsFromJson(null)).toEqual([]);
    expect(modelIdsFromJson("不是 JSON 对象")).toEqual([]);
  });

  it("RPC 风格（清单在 result 里）也认", () => {
    expect(modelIdsFromJson({ result: { data: [{ id: "m1" }] } })).toEqual(["m1"]);
  });

  it("地址规整：三种常见填法都要对", () => {
    expect(modelsUrlFor("https://api.x.com")).toBe("https://api.x.com/v1/models");
    expect(modelsUrlFor("https://api.x.com/v1")).toBe("https://api.x.com/v1/models");
    expect(modelsUrlFor("https://api.x.com/v1/chat/completions")).toBe("https://api.x.com/v1/models");
    expect(modelsUrlFor("https://api.x.com/v1/")).toBe("https://api.x.com/v1/models");
  });
});

/**
 * M-07：端点自报能力（照 Continue 的 `fetchModels.ts` 那份映射）。
 *
 * 三条形状各钉一条；认不出来的字段**必须留空**（走目录/默认，不编）。
 */
describe("端点自报的能力", () => {
  it("OpenRouter：context_length + top_provider.max_completion_tokens + architecture.input_modalities", () => {
    const got = modelCapsFromJson({
      data: [
        {
          id: "deepseek/deepseek-chat",
          context_length: 163840,
          top_provider: { max_completion_tokens: 16000 },
          architecture: { input_modalities: ["text", "file"] },
          supported_parameters: ["tools", "reasoning"],
        },
      ],
    });
    expect(got["deepseek/deepseek-chat"]).toEqual({
      contextWindow: 163840,
      maxOutput: 16000,
      inputModalities: ["text", "pdf"],
      reasoning: true,
    });
  });

  it("Anthropic：max_input_tokens / max_tokens", () => {
    const got = modelCapsFromJson({ data: [{ id: "claude-sonnet-4-5", max_input_tokens: 200000, max_tokens: 8192 }] });
    expect(got["claude-sonnet-4-5"]).toEqual({ contextWindow: 200000, maxOutput: 8192 });
  });

  it("Gemini：inputTokenLimit / outputTokenLimit", () => {
    const got = modelCapsFromJson({ models: [{ name: "gemini-2.5-pro", inputTokenLimit: 1048576, outputTokenLimit: 65536 }] });
    expect(got["gemini-2.5-pro"]).toEqual({ contextWindow: 1048576, maxOutput: 65536 });
  });

  it("⭐ 什么字段都不认识的条目**不出现**（不拿默认值冒充端点数据）", () => {
    expect(modelCapsFromJson({ data: [{ id: "mystery-model" }] })).toEqual({});
  });
});
