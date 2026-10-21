import { describe, expect, it } from "vitest";

import { cascadePlan } from "./providerCascade";

/**
 * M-06：删除/隐藏的级联计划。
 *
 * 判据：自定义供应商删除要清三样（声明/设置/密钥），内置只能隐藏。
 */
describe("级联计划", () => {
  const declared = [
    { providerId: "my-relay", modelId: "a" },
    { providerId: "my-relay", modelId: "b" },
    { providerId: "other", modelId: "c" },
  ];

  it("⭐ 自定义供应商：计划里有声明、启用数与设置项", () => {
    const plan = cascadePlan("my-relay", {
      declared,
      settings: { "my-relay": { enabled: ["a"] } },
      keyRef: "MY_RELAY_API_KEY",
    });
    expect(plan.action).toBe("delete");
    if (plan.action !== "delete") return;
    expect(plan.declaredModels).toEqual(["a", "b"]);
    expect(plan.enabledCount).toBe(1);
    expect(plan.clearsSettings).toBe(true);
    expect(plan.keyRef).toBe("MY_RELAY_API_KEY");
  });

  it("没有声明/设置时也不报错（数字为 0）", () => {
    const plan = cascadePlan("fresh", { declared: [] });
    expect(plan).toMatchObject({ action: "delete", declaredModels: [], enabledCount: 0, clearsSettings: false });
  });

  it("⭐ 内置供应商只能隐藏（删了下次启动又回来）", () => {
    expect(cascadePlan("deepseek", { declared })).toEqual({ action: "hide", providerId: "deepseek" });
  });
});
