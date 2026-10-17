import { describe, expect, it } from "vitest";

import { redactDeep, redactSecrets } from "./redact";

/**
 * 密钥脱敏（U14）。
 *
 * 这一组挡的是"secret 从错误的原文里漏出去"：诊断包、终端、错误详情
 * 都是**会给第三方看**的文本。
 */

describe("redactSecrets", () => {
  it("⭐ 常见前缀的 key 被盖掉（保留前 4 位便于排查是哪把）", () => {
    const got = redactSecrets("key=sk-proj-abcdefghijklmnop 用不了");
    expect(got).toContain("sk-p");
    expect(got).not.toContain("abcdefghijklmnop");
    expect(got).toContain("已脱敏");
  });

  it("⭐ Authorization 头", () => {
    const got = redactSecrets("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' https://x");
    expect(got).toContain("Bearer eyJh…");
    expect(got).not.toContain("payload.sig");
  });

  it("⭐ URL 查询参数里的 token", () => {
    const got = redactSecrets("https://api.example.com/v1?api_key=abcdef123456&x=1");
    expect(got).toContain("api_key=abcd…");
    expect(got).not.toContain("abcdef123456");
  });

  it("⭐ 键值对（JSON / yaml / .env 风格）", () => {
    for (const raw of ['"api_key": "abcdef123456789"', "password=supersecret123", "client_secret: zzzzzzzzzz"]) {
      const got = redactSecrets(raw);
      expect(got, raw).toContain("已脱敏");
    }
  });

  it("正常文本不被误伤（模型名、路径、普通单词）", () => {
    const raw = "已连接 deepseek-flash；文件 C:/DingHarness/src/app.ts；password 字段（说明文字）";
    expect(redactSecrets(raw)).toBe(raw);
  });

  it("多条一起出现时每一条都被处理", () => {
    const got = redactSecrets("sk-aaaaaaaaaa 和 ghp_bbbbbbbbbbbbbbbb 和 Bearer cccccccccccc");
    expect(got).not.toContain("aaaaaaaaaa");
    expect(got).not.toContain("bbbbbbbbbbbbbbbb");
    expect(got).not.toContain("cccccccccccc");
  });

  it("空值不抛", () => {
    expect(redactSecrets("")).toBe("");
  });
});

describe("redactDeep", () => {
  it("递归盖掉对象/数组里的字符串，不改原对象", () => {
    const input = { a: "sk-1234567890abcdef", b: ["ghp_aaaaaaaaaaaaaaaa", 1], c: { d: "ok" } };
    const got = redactDeep(input) as typeof input;
    expect(got.a).toContain("已脱敏");
    expect(got.b[0]).toContain("已脱敏");
    expect(got.c.d).toBe("ok");
    expect(input.a, "原对象被改了").toBe("sk-1234567890abcdef");
  });
});
