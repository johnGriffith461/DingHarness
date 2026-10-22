import { describe, expect, it } from "vitest";

import { blockedReason, isPrivateHost } from "./browserUrl";

/**
 * B-05：浏览器地址策略（方案 §2 第 7 条）。
 *
 * 8 条拒绝 + 2 条放行 —— 每条都写清"为什么"（拒绝理由要能直接给模型看）。
 */
describe("地址策略", () => {
  it("非 http(s) 一律拒（file/data/javascript/about）", () => {
    for (const url of [
      "file:///C:/Windows/win.ini",
      "data:text/html,<h1>x</h1>",
      "javascript:alert(1)",
      "about:config",
      "ftp://example.com/a",
    ]) {
      expect(blockedReason(url), url).not.toBeNull();
    }
  });

  it("私网与回环默认拒，显式开 allowLocal 才放行", () => {
    for (const url of ["http://127.0.0.1:8080", "http://10.0.0.5", "http://192.168.1.1", "http://localhost:3000"]) {
      expect(blockedReason(url), url).not.toBeNull();
      expect(blockedReason(url, { allowLocal: true }), url).toBeNull();
    }
  });

  it("带凭据的 URL 拒（会进日志）", () => {
    expect(blockedReason("https://user:pass@example.com/")).toContain("账号密码");
  });

  it("公网 https 放行", () => {
    expect(blockedReason("https://example.com/a?b=1")).toBeNull();
    expect(blockedReason("about:blank")).toBeNull();
  });

  it("私网判定覆盖各段", () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.1", "169.254.1.1", "::1", "foo.local", "localhost"]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ["example.com", "8.8.8.8", "172.32.0.1"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});
