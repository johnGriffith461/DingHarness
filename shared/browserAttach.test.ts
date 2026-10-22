import { describe, expect, it } from "vitest";

import { NOT_ATTACHED_NOTICE, isAttachable } from "./browserAttach";

/**
 * B-01：只接右栏的 `<webview>`。
 *
 * 反例是真实存在的：主窗口（`window`）、独立窗口（`browserView`/`remote`）、
 * devtools 都可能被误接进来 —— 那等于让模型去点用户的工作台。
 */
describe("浏览器接线", () => {
  it("只接受 webview", () => {
    expect(isAttachable("webview")).toBe(true);
  });

  it("主窗口 / 其它类型一律拒绝", () => {
    for (const type of ["window", "browserView", "remote", "webview-panel", "", undefined, null]) {
      expect(isAttachable(type as string | undefined), String(type)).toBe(false);
    }
  });

  it("未接上的话术说清下一步，不是报错码", () => {
    expect(NOT_ATTACHED_NOTICE).toContain("右栏");
    expect(NOT_ATTACHED_NOTICE).not.toContain("null");
  });
});
