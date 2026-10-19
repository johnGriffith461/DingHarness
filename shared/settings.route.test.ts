import { describe, expect, it } from "vitest";

import { pickRoute } from "./settings";

/**
 * §183/§184 的路由选择（纯函数）。
 *
 * 这里补的是 2026-10-19 真机撞到的那一格：
 * **钉住的模型不在 provider 清单里**（用户自己声明的模型）时，
 * `pickRoute` 会退回 `last`；而新对话的 `last` 是空的 ——
 * 调用方如果直接采信，就会拿到一个**空 provider**。
 */
describe("pickRoute", () => {
  const last = { provider: "deepseek", model: "deepseek-chat" };

  it("钉住的在可用列表里 → pinned", () => {
    const got = pickRoute({ pinned: "p/deepseek-v9", last: { provider: "", model: "" }, fresh: true, available: ["p/deepseek-v9"] });
    expect(got).toMatchObject({ provider: "p", model: "deepseek-v9", source: "pinned", fellBack: false });
  });

  it("钉住的不在可用列表里 → 退回 last（有值）", () => {
    const got = pickRoute({ pinned: "p/custom-model", last, fresh: true, available: ["deepseek/deepseek-chat"] });
    expect(got).toMatchObject({ ...last, source: "last", fellBack: true });
  });

  it("⭐ 钉住的不在可用列表、且 last 为空 → provider 为空（调用方必须继续兜底，不能直接采信）", () => {
    const got = pickRoute({
      pinned: "p/custom-model",
      last: { provider: "", model: "" },
      fresh: true,
      available: ["deepseek/deepseek-chat"],
    });
    expect(got.provider).toBe("");
    expect(got.fellBack).toBe(true);
  });

  it("没钉、有 last → last", () => {
    const got = pickRoute({ pinned: "", last, fresh: true, available: [] });
    expect(got).toMatchObject({ ...last, source: "last" });
  });
});
