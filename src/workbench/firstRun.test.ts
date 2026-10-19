import { describe, expect, it } from "vitest";

import { shouldShowFirstRun } from "./FirstRunGuide";

/**
 * 首跑向导的**出现条件**（U06）。
 *
 * 判据就三条：设置载入了、没钉住默认模型、所有 provider 都没有可用 key。
 * 少一条就会变成"已经配好的人每次都被挡一下"—— 那比没有向导更烦。
 */

const provider = (available: boolean) =>
  ({ id: "p", label: "P", models: ["m"], note: "", available, keyRef: "P_KEY" }) as never;

describe("shouldShowFirstRun", () => {
  it("⭐ 三条都满足才弹", () => {
    expect(shouldShowFirstRun(true, "", [provider(false)])).toBe(true);
  });

  it("已经钉住默认模型 → 不弹", () => {
    expect(shouldShowFirstRun(true, "p/m", [provider(false)])).toBe(false);
  });

  it("有 key 但没有钉住模型 → **仍然弹**（落在选模型那一步，P0-08）", () => {
    expect(shouldShowFirstRun(true, "", [provider(false), provider(true)])).toBe(true);
  });

  it("有 key 且钉住模型 → 不弹", () => {
    expect(shouldShowFirstRun(true, "p/m", [provider(true)])).toBe(false);
  });

  it("设置还没载入 / provider 还没读到 → 不弹（避免闪一下）", () => {
    expect(shouldShowFirstRun(false, "", [provider(false)])).toBe(false);
    expect(shouldShowFirstRun(true, "", null)).toBe(false);
  });

  /*
   * ⚠️ 2026-10-19 主人实测：他在输入区选过模型（`dsh-canvas.chat-settings` 有值），
   * 但没走完向导（`settings.pinnedModel` 仍是空）—— 于是每次开应用首跑卡都弹。
   * 已经在用某个模型的人不该被反复要求"再选一次"。
   */
  it("⭐ 已经保存过路由（输入区选过模型）→ 不弹", () => {
    expect(shouldShowFirstRun(true, "", [provider(true)], { savedRoute: "p/m" })).toBe(false);
  });

  it("保存的路由半个值（缺 model）不算数 → 仍然弹", () => {
    expect(shouldShowFirstRun(true, "", [provider(true)], { savedRoute: "p/" })).toBe(true);
  });
});
