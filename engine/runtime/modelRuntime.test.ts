import { describe, expect, it } from "vitest";

import { nativeSearchToolFor, validateCapabilityForProtocol } from "./modelRuntime";
import { TEXT_ONLY_INPUT } from "./modelConfig";

/**
 * 能力 → 运行时（T0）。
 *
 * 核心一条：**协议不支持的能力要在保存时就报错**。
 * 勾了"原生联网"但协议没这个能力，发请求时无声无息 ——
 * 用户会以为开着，其实没效果。那种"静默不生效"比直接拒绝保存坏得多。
 */

describe("原生联网工具注入", () => {
  it("Anthropic 有原生联网", () => {
    const injection = nativeSearchToolFor("anthropic");
    expect(injection?.label).toContain("Anthropic");
    expect(Object.keys(injection!.tools).length).toBe(1);
  });

  it("Google 有原生联网", () => {
    expect(nativeSearchToolFor("google")?.label).toContain("Google");
  });

  it("OpenAI 兼容没有（那是一堆实现，没有统一的原生搜索）", () => {
    expect(nativeSearchToolFor("openai-compatible")).toBeUndefined();
  });
});

describe("保存时的能力校验", () => {
  it("OpenAI 兼容 + 勾了原生联网 → 拒绝保存并说明怎么改", () => {
    const error = validateCapabilityForProtocol("openai-compatible", {
      supportsNativeWebSearch: true,
      inputFormat: TEXT_ONLY_INPUT,
    });
    expect(error).toContain("不支持原生联网搜索");
    expect(error).toContain("Anthropic");
  });

  it("Anthropic + 勾了原生联网 → 放行", () => {
    expect(
      validateCapabilityForProtocol("anthropic", {
        supportsNativeWebSearch: true,
        inputFormat: TEXT_ONLY_INPUT,
      }),
    ).toBeNull();
  });

  it("Anthropic + 勾了视频 → 拒绝（官方 API 不收视频）", () => {
    expect(
      validateCapabilityForProtocol("anthropic", {
        supportsNativeWebSearch: false,
        inputFormat: { ...TEXT_ONLY_INPUT, supportsVideo: true },
      }),
    ).toContain("视频");
  });

  it("Google + 视频 → 放行（按 file part 走）", () => {
    expect(
      validateCapabilityForProtocol("google", {
        supportsNativeWebSearch: false,
        inputFormat: { ...TEXT_ONLY_INPUT, supportsVideo: true },
      }),
    ).toBeNull();
  });

  it("什么能力都不勾 → 任何协议都放行（不误伤）", () => {
    for (const protocol of ["openai-compatible", "anthropic", "google"] as const) {
      expect(
        validateCapabilityForProtocol(protocol, {
          supportsNativeWebSearch: false,
          inputFormat: TEXT_ONLY_INPUT,
        }),
      ).toBeNull();
    }
  });
});
