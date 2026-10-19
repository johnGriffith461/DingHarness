import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveReviewDirs } from "./cmdReview";

/**
 * T-08：`ding review --revert` 的白名单来源。
 *
 * 缺陷形状（WorkBuddy 实测）：用户照 `ding review` 打印的建议敲命令，
 * 但白名单里没有那个任务当初跑的目录 → 必然报"不在可改范围内"，
 * 而用户不知道要补 `--dir`。
 */
describe("resolveReviewDirs", () => {
  const cwd = "C:/repo";

  it("显式 --dir 优先", () => {
    const got = resolveReviewDirs({ explicit: ["C:/a"], fromSession: ["C:/b"], configured: ["C:/c"], cwd });
    expect(got).toEqual([path.resolve("C:/a")]);
  });

  it("⭐ 没给 --dir 时继承会话运行目录", () => {
    const got = resolveReviewDirs({ explicit: [], fromSession: ["C:/task-dir"], configured: ["C:/cfg"], cwd });
    expect(got).toEqual([path.resolve("C:/task-dir")]);
  });

  it("会话没记目录 → 回落配置", () => {
    const got = resolveReviewDirs({ explicit: [], fromSession: [], configured: ["C:/cfg"], cwd });
    expect(got).toEqual([path.resolve("C:/cfg")]);
  });

  it("都没有 → 当前目录（老行为不变）", () => {
    expect(resolveReviewDirs({ explicit: [], fromSession: [], configured: [], cwd })).toEqual([path.resolve(cwd)]);
  });
});
