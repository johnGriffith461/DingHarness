import { beforeEach, describe, expect, it, afterEach } from "vitest";

import type { Protocol } from "./models";
import { acceptProvidersEnabled, allProviders, getProvider, isBuiltinProviderId, protocolOf } from "./providers";

/**
 * provider 表（2026-10-21 收窄之后）。
 *
 * ## 出厂只有 DeepSeek 一家（主人拍板）
 *
 * 原话：「软件不要给它去内置那些渠道了吧 就留一个 Deepseek 渠道就行，
 * 然后 Deepseek 的渠道信息都给填好了，让用户只用输入 key 就行」。
 *
 * 所以这里钉三件事：
 * 1. **出厂表只有一家**（用户打开设置/首跑向导不会看到一堆没用过的中转站）；
 * 2. **那一家的地址/协议/模型都填好了**（用户只需要一条 key）；
 * 3. **验收通道默认不在表里**（`strata` 只在 `DING_ACCEPT_PROVIDERS=1` 时出现 ——
 *    这条是主人当场质疑"是不是还用着你假通道"的落点）。
 *
 * ⚠️ 删的是**表项**，不是能力：三种协议仍支持（自定义供应商可选 anthropic / google）。
 */

beforeEach(() => {
  /* 测试环境默认打开了验收通道（见 vitest.config.ts）；这一组要断言**出厂**表，所以先关掉 */
  delete process.env.DING_ACCEPT_PROVIDERS;
});

afterEach(() => {
  delete process.env.ANTHROPIC_MODELS;
  delete process.env.DEEPSEEK_MODELS;
  /* 恢复测试环境默认值（别让本文件把别的用例的 strata 关掉） */
  process.env.DING_ACCEPT_PROVIDERS = "1";
});

describe("出厂 provider 表", () => {
  it("⭐ 只有 DeepSeek 一家（其余都由用户自己添加）", () => {
    const ids = allProviders().map((p) => p.id);
    expect(ids).toEqual(["deepseek"]);
  });

  it("⭐ DeepSeek 的渠道信息全部预填好（地址 + 协议 + 模型 + key 名）", () => {
    const deepseek = getProvider("deepseek");
    expect(deepseek).toBeDefined();
    expect(deepseek!.baseURL).toBe("https://api.deepseek.com/v1");
    expect(deepseek!.protocol).toBe("openai-compatible");
    expect(deepseek!.keyRef).toBe("DEEPSEEK_API_KEY");
    expect(deepseek!.models.length).toBeGreaterThan(0);
    expect(deepseek!.models).toContain("deepseek-chat");
  });

  it("每家都声明了合法协议，id 不重复，模型清单非空", () => {
    const ALL: Protocol[] = ["openai-compatible", "openai-responses", "anthropic", "google"];
    const ids = allProviders().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of allProviders()) {
      expect(ALL, `${p.id} 的协议`).toContain(p.protocol);
      expect(p.models.length, `${p.id} 没有任何模型`).toBeGreaterThan(0);
      expect(p.baseURL, `${p.id} 没有地址`).toMatch(/^https?:\/\//);
    }
  });

  it("模型清单可用 `DEEPSEEK_MODELS` 覆盖（模型名会变，而它是配置不是数据）", () => {
    process.env.DEEPSEEK_MODELS = "deepseek-flash , deepseek-v4-pro";
    expect(getProvider("deepseek")?.models).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("覆盖成空串时**不生效**（否则用户手滑一下就没模型可用了）", () => {
    process.env.DEEPSEEK_MODELS = "   ";
    expect(getProvider("deepseek")?.models.length).toBeGreaterThan(0);
  });

  it("protocolOf：不认识的 provider 按 OpenAI 兼容（别把请求发歪）", () => {
    expect(protocolOf("deepseek")).toBe("openai-compatible");
    expect(protocolOf("没有这家")).toBe("openai-compatible");
  });
});

describe("验收通道（strata）默认不可见", () => {
  it("⭐ 没开开关时，出厂表里**没有** strata —— 用户不会看到'本地测试通道'", () => {
    expect(getProvider("strata")).toBeUndefined();
    expect(acceptProvidersEnabled()).toBe(false);
    expect(allProviders().some((p) => p.id === "strata")).toBe(false);
  });

  it("开了 `DING_ACCEPT_PROVIDERS=1` 才有（批跑 / eval / bench 用）", () => {
    process.env.DING_ACCEPT_PROVIDERS = "1";
    expect(acceptProvidersEnabled()).toBe(true);
    const strata = getProvider("strata");
    expect(strata).toBeDefined();
    expect(strata!.keyRef).toBe("STRATA_API_KEY");
    /* 地址仍可由 STRATA_BASE_URL 覆盖到本机假服务 */
    expect(strata!.baseURL).toMatch(/^http:\/\/127\.0\.0\.1/);
  });

  it("strata 这个 id 是**保留**的：自定义供应商不能占用（哪怕它不在出厂表里）", () => {
    expect(isBuiltinProviderId("deepseek")).toBe(true);
    expect(isBuiltinProviderId("strata")).toBe(true);
    expect(isBuiltinProviderId("my-relay")).toBe(false);
  });
});
