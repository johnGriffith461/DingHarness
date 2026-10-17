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

  it("任何一家有可用 key → 不弹", () => {
    expect(shouldShowFirstRun(true, "", [provider(false), provider(true)])).toBe(false);
  });

  it("设置还没载入 / provider 还没读到 → 不弹（避免闪一下）", () => {
    expect(shouldShowFirstRun(false, "", [provider(false)])).toBe(false);
    expect(shouldShowFirstRun(true, "", null)).toBe(false);
  });
});
