import { describe, expect, it } from "vitest";

import { badgeOf, isConfigured } from "./providerBadge";

/**
 * M-02：密钥来源徽标。
 *
 * 判据是主人那条"不许把别的程序的 key 算成我们的"：
 * 五种状态的**文案与类名必须两两不同** —— 合并任意两种都会让用户看不出
 * "这条 key 其实不是你在本应用里配的"。
 */
describe("provider 密钥状态徽标", () => {
  it("五种状态映射到五个不同的文案与类名", () => {
    const all = [
      badgeOf({ keySource: "app", configured: true, verified: true }),
      badgeOf({ keySource: "app", configured: true }),
      badgeOf({ keySource: "env" }),
      badgeOf({ keySource: "legacy" }),
      badgeOf({ keySource: "none" }),
    ];
    expect(new Set(all.map((b) => b.text)).size).toBe(5);
    expect(new Set(all.map((b) => b.className)).size).toBe(5);
  });

  it("⭐ 旧目录不算「已配置」—— 这是主人报的第 1 条", () => {
    const legacy = badgeOf({ keySource: "legacy", available: true });
    expect(legacy.text).toBe("来自旧目录");
    expect(legacy.text).not.toContain("已保存");
    expect(isConfigured({ keySource: "legacy", available: true })).toBe(false);
  });

  it("环境变量给黄点并写出变量名（用户能去关掉它）", () => {
    const env = badgeOf({ keySource: "env", keyRef: "DEEPSEEK_API_KEY" });
    expect(env.text).toBe("来自环境变量");
    expect(env.title).toContain("DEEPSEEK_API_KEY");
    expect(isConfigured({ keySource: "env" })).toBe(false);
  });

  it("本应用保存 + 真调通过才升「已验证」", () => {
    expect(badgeOf({ keySource: "app", verified: false }).text).toBe("本应用已保存");
    expect(badgeOf({ keySource: "app", verified: true }).text).toBe("已验证");
    expect(isConfigured({ keySource: "app" })).toBe(true);
  });

  it("旧夹具（没有 keySource）按 available 回落，不炸", () => {
    expect(badgeOf({ available: true }).state).toBe("app");
    expect(badgeOf({ available: false }).state).toBe("none");
    expect(badgeOf({}).state).toBe("none");
  });
});
