import { describe, expect, it } from "vitest";

import { previewableUrl } from "@shared/preview";

/**
 * 内置预览的地址策略（V6-2m）。
 *
 * 判据只有一条：**只开本机地址**。预览窗口不带应用的 preload，
 * 但它也不该变成一个能上任意网站的浏览器 —— 尤其是这个入口会被 agent 触达。
 */

describe("预览地址策略", () => {
  it("本机地址放行（含 IPv6 与 *.localhost）", () => {
    for (const url of [
      "http://localhost:3000",
      "http://127.0.0.1:5173/app",
      "https://127.0.0.1",
      "http://[::1]:8080",
      "http://myapp.localhost:3000",
    ]) {
      expect(previewableUrl(url), url).toBeTruthy();
    }
  });

  it("外部地址 / 非 http(s) / 坏的 URL 一律拒", () => {
    for (const url of [
      "http://example.com",
      "https://github.com/x",
      "file:///C:/Windows/System32",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "not a url",
      "",
    ]) {
      expect(previewableUrl(url), url).toBeNull();
    }
  });

  it("大小写与尾部斜杠不影响判断", () => {
    expect(previewableUrl("HTTP://LOCALHOST:3000/")?.host).toBe("localhost:3000");
  });
});
