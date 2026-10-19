import { describe, expect, it } from "vitest";

import { subPageForLabel } from "./settingsSubPage";

/**
 * T-05：设置左栏点「记忆」，右侧主面板要**跟着切**。
 *
 * 缺陷形状：`记忆` 不是 `SettingsSubPage`，点它只把 `memoryOpen` 打开、
 * 在左栏里内联展开面板，而右侧仍是上一页（模型/知识库）——
 * 用户点完以为自己点错了（WorkBuddy 跨两个构建复现）。
 *
 * 判据是纯映射：左栏标签 → 子页（`null` = 不是子页）。
 */
describe("subPageForLabel", () => {
  it("记忆 → memory", () => {
    expect(subPageForLabel("记忆")).toBe("memory");
  });

  it("其它已知子页照旧", () => {
    expect(subPageForLabel("模型")).toBe("models");
    expect(subPageForLabel("团队空间")).toBe("team");
    expect(subPageForLabel("知识库")).toBe("knowledge");
    expect(subPageForLabel("本机档案")).toBe("profile");
  });

  it("不是子页的标签 → null（由调用方决定别的动作）", () => {
    expect(subPageForLabel("外观")).toBeNull();
    expect(subPageForLabel("随便写点什么")).toBeNull();
  });
});
