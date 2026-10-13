import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：`pnpm build` **必须**带齐五道门。
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
 *
 * ── A2（2026-10-13）补在最前面的两道门 ──
 *
 * `build` 原来**既没有 `typecheck` 也没有 `test`**：`vite build` 走 esbuild，
 * 而 esbuild **只剥类型、不做类型检查** —— 所以"类型已经错了"和"用例已经红了"
 * 都能一路跑到 `electron-builder` 打包完成，最后交给三道 verify。
 * 这两道门补在链首，顺序本身有意义：**先证这棵树自洽，再花几分钟出产物**。
 *
 * ⚠️ 反过来说：这道守卫以前是"包含式"断言（只检查三个字符串在不在），
 * 所以"**新加的门没写进来**"它一次都拦不住 —— 那正是 A2 交付时发生的事。
 * 现在改成**整条步骤表逐字全等**。见 `EXPECTED_STEPS`。
 *
 * ── B3（2026-10-13）补的第三道门 ──
 *
 * `pnpm lint`（oxlint，**只开 `no-unused-vars` / `no-undef` 两条**，见 `.oxlintrc.json`）
 * 插在 `typecheck` 之后。两条规则都做过**证伪**：探针里放一个未使用的局部变量
 * 与一个未定义标识符时，`oxlint` 分别报出这两条并退出码 1；删掉探针回到 0/0。
 * 一个只会返回 0 的检查等于没有，所以它必须能红。
 */
const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** `build` 链切成一步步（按 `&&` 切，去空白）。 */
function steps(build: string): string[] {
  return build
    .split("&&")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 期望的完整步骤表 —— **逐字**。
 *
 * 故意用"全等"而不是"包含"：包含式断言挡不住**悄悄多出来**的一步，
 * 而"多一步"和"少一步"一样会改变 `pnpm build` 的含义（比如多跑一次真调模型的脚本）。
 * 谁改了 `build`，这一条就红，逼他把意图写下来。
 */
const EXPECTED_STEPS = [
  // ① 自洽性：类型 / lint / 用例（A2 加前两道，B3 加 lint）
  "pnpm typecheck",
  "pnpm lint",
  "pnpm test",
  // ② 出产物
  "pnpm build:web",
  "pnpm electron:build",
  "electron-builder --win nsis",
  // ③ 拿产物去验（顺序不可换：产物先出来）
  "node scripts/verify-artifacts.mjs",
  "node scripts/verify-packaged.mjs",
  "node scripts/verify-acceptances.mjs",
];

describe("pnpm build 的门禁链", () => {
  const build = pkg.scripts.build ?? "";
  const got = steps(build);

  it("⭐ 步骤表与期望**逐字一致**（多一步少一步都红）", () => {
    expect(got).toEqual(EXPECTED_STEPS);
  });

  it("六道门都在（类型 / lint / 用例 / 新鲜度 / 打包后可用 / 行为验收）", () => {
    expect(build, "缺少类型门禁").toContain("pnpm typecheck");
    expect(build, "缺少 lint 门禁").toContain("pnpm lint");
    expect(build, "缺少用例门禁").toContain("pnpm test");
    expect(build, "缺少新鲜度门禁").toContain("scripts/verify-artifacts.mjs");
    expect(build, "缺少打包后可用性门禁").toContain("scripts/verify-packaged.mjs");
    expect(build, "缺少行为验收门禁 —— 这正是 §140 撞到的那个回归").toContain("scripts/verify-acceptances.mjs");
  });

  it("⚠️ 顺序：先自洽，再打包，最后拿产物去验", () => {
    const at = (needle: string) => build.indexOf(needle);
    // 自洽性必须在出产物之前 —— 反过来的话，几分钟的打包时间换不来任何信息
    expect(at("pnpm typecheck"), "typecheck 必须在打包之前").toBeLessThan(at("electron-builder"));
    expect(at("pnpm lint"), "lint 必须在打包之前").toBeLessThan(at("electron-builder"));
    expect(at("pnpm test"), "test 必须在打包之前").toBeLessThan(at("electron-builder"));
    // 产物先出来，再拿产物去验
    expect(at("electron-builder"), "打包必须在三道门之前").toBeGreaterThan(-1);
    expect(at("scripts/verify-artifacts.mjs")).toBeGreaterThan(at("electron-builder"));
    expect(at("scripts/verify-packaged.mjs")).toBeGreaterThan(at("scripts/verify-artifacts.mjs"));
    expect(at("scripts/verify-acceptances.mjs")).toBeGreaterThan(at("scripts/verify-packaged.mjs"));
  });

  it("用 && 串起来（任何一道红就整体失败，不是分号那种'红了也继续'）", () => {
    expect(build).not.toContain(";");
    expect(got.length).toBeGreaterThanOrEqual(6);
  });

  it("引用的脚本、npm script 与 lint 配置都真的存在（清单指向不存在的东西 = 假门禁）", () => {
    for (const f of ["scripts/verify-artifacts.mjs", "scripts/verify-packaged.mjs", "scripts/verify-acceptances.mjs"]) {
      expect(() => readFileSync(path.join(ROOT, f), "utf8"), `${f} 不存在`).not.toThrow();
    }
    // 新门引的是 npm script，不是文件 —— 所以这里查 scripts 表
    for (const name of ["typecheck", "lint", "test", "build:web", "electron:build"]) {
      expect(pkg.scripts[name], `package.json 里没有 ${name} 这个 script`).toBeTruthy();
    }
    // lint 的规则集写在配置文件里，缺了它就退回默认那一大坨（B3 明确只开两条）
    const rc = JSON.parse(readFileSync(path.join(ROOT, ".oxlintrc.json"), "utf8")) as {
      rules?: Record<string, string>;
    };
    expect(Object.keys(rc.rules ?? {}).sort(), "lint 规则集被改动了").toEqual(["no-undef", "no-unused-vars"]);
  });
});
