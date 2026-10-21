import { describe, expect, it } from "vitest";

import { formatFromUrl, nameFromUrl } from "./providerForm";

/**
 * M-03：新供应商表单的两条推断。
 *
 * 判据来自主人的要求（字段顺序 URL → Key → 模型）与"选错格式的表现是 404"：
 * 推断可以替用户省一步，但**必须可改**，且不能把 `/v1/chat/completions` 误判成 responses。
 */
describe("从 URL 推名字", () => {
  it("带协议的完整地址 → host", () => {
    expect(nameFromUrl("https://api.example.com/v1")).toBe("api.example.com");
  });

  it("只写 host 也能推（用户常常不写协议）", () => {
    expect(nameFromUrl("api.example.com/v1")).toBe("api.example.com");
  });

  it("带端口与末尾斜杠", () => {
    expect(nameFromUrl("http://127.0.0.1:8080/v1/")).toBe("127.0.0.1:8080");
  });

  it("空串 → 空串（不编一个假名字）", () => {
    expect(nameFromUrl("")).toBe("");
    expect(nameFromUrl("   ")).toBe("");
  });
});

describe("从 URL 推线路格式", () => {
  it("含 /messages → anthropic", () => {
    expect(formatFromUrl("https://api.anthropic.com/v1/messages")).toBe("anthropic");
  });

  it("含 /responses → openai-responses", () => {
    expect(formatFromUrl("https://api.openai.com/v1/responses")).toBe("openai-responses");
  });

  it("其余 → openai-compatible", () => {
    expect(formatFromUrl("https://api.example.com/v1")).toBe("openai-compatible");
    expect(formatFromUrl("https://api.example.com/v1/chat/completions")).toBe("openai-compatible");
    expect(formatFromUrl("")).toBe("openai-compatible");
  });

  it("⭐ 反例：/v1/chat/completions 不能被误判成 responses", () => {
    expect(formatFromUrl("https://api.openai.com/v1/chat/completions")).not.toBe("openai-responses");
  });

  it("路径段匹配，不误伤名字里带 responses 的普通路径", () => {
    expect(formatFromUrl("https://x.com/v1/my-responses-proxy")).toBe("openai-compatible");
  });
});
