import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：`pnpm build` **必须**带齐三道门。
 *
 * ⚠️ 为什么要有这一条（§140）：`verify-acceptances` 曾经被加进 `build`（§108 记录并实测过
 * "端到端跑通 14/14"），**后来又不见了** —— `package.json` 在后来的几次事故里被重写过
 * （从零重建、依赖脚本改写），那道门就悄悄没了。
 *
 * 后果很隐蔽：我照旧跑 `pnpm build`、看到退出码 0，就以为"门禁全绿"，
 * 而实际上**验收那一道根本没跑**。这跟项目里反复清的那类问题同源 ——
 * 只不过这次发生在**门禁自己身上**：
 *
 *   > 一道会悄悄消失的检查，等于没有。
 *
 * 所以用一条测试把它钉住。改 `build` 是有意的工程动作，那就得同时改这条测试。
 */
const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("pnpm build 的门禁链", () => {
  const build = pkg.scripts.build ?? "";

  it("三道门都在（新鲜度 / 打包后可用 / 行为验收）", () => {
    expect(build, "缺少新鲜度门禁").toContain("scripts/verify-artifacts.mjs");
    expect(build, "缺少打包后可用性门禁").toContain("scripts/verify-packaged.mjs");
    expect(build, "缺少行为验收门禁 —— 这正是 §140 撞到的那个回归").toContain("scripts/verify-acceptances.mjs");
  });

  it("⚠️ 顺序：产物先出来，再拿产物去验", () => {
    const at = (needle: string) => build.indexOf(needle);
    expect(at("electron-builder"), "打包必须在三道门之前").toBeGreaterThan(-1);
    expect(at("scripts/verify-artifacts.mjs")).toBeGreaterThan(at("electron-builder"));
    expect(at("scripts/verify-packaged.mjs")).toBeGreaterThan(at("scripts/verify-artifacts.mjs"));
    expect(at("scripts/verify-acceptances.mjs")).toBeGreaterThan(at("scripts/verify-packaged.mjs"));
  });

  it("用 && 串起来（任何一道红就整体失败，不是分号那种'红了也继续'）", () => {
    expect(build).not.toContain(";");
    expect(build.split("&&").length).toBeGreaterThanOrEqual(6);
  });

  it("三个 verify 脚本真的存在（清单指向不存在的脚本 = 假门禁）", () => {
    for (const f of ["scripts/verify-artifacts.mjs", "scripts/verify-packaged.mjs", "scripts/verify-acceptances.mjs"]) {
      expect(() => readFileSync(path.join(ROOT, f), "utf8"), `${f} 不存在`).not.toThrow();
    }
  });
});
