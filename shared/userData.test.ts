import { describe, expect, it } from "vitest";

import { DEV_PROFILE_DIRNAME, resolveUserData } from "./userData";

/**
 * M-08：数据目录选择。
 *
 * 主人报的第 6 条（装完有两条我们的任务）根因就是这里：
 * dev 与装机版共用了同一个 profile。三条判据逐条钉住。
 */
describe("数据目录选择", () => {
  const base = { appData: "C:/Users/x/AppData/Roaming", currentUserData: "C:/Users/x/AppData/Roaming/Ding Harness" };

  it("⭐ dev 用独立 profile（不再污染用户装完看到的目录）", () => {
    const got = resolveUserData({ ...base, isPackaged: false });
    expect(got.reason).toBe("dev");
    expect(got.userData).toContain(DEV_PROFILE_DIRNAME);
    expect(got.userData).not.toBe(base.currentUserData);
  });

  it("打包版用 Electron 默认的 userData", () => {
    const got = resolveUserData({ ...base, isPackaged: true });
    expect(got).toEqual({ userData: base.currentUserData, reason: "packaged" });
  });

  it("⭐ 显式覆盖优先级最高（验收/便携模式）", () => {
    expect(resolveUserData({ ...base, isPackaged: true, override: "D:/tmp/data" })).toEqual({
      userData: "D:/tmp/data",
      reason: "override",
    });
    expect(resolveUserData({ ...base, isPackaged: false, override: "D:/tmp/data2" }).userData).toBe("D:/tmp/data2");
  });

  it("空覆盖 = 没给（不把空串当目录）", () => {
    expect(resolveUserData({ ...base, isPackaged: false, override: "   " }).reason).toBe("dev");
  });
});
