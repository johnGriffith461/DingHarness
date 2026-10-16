import { existsSync, readFileSync } from "node:fs";
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
  // ①.5 路径校验（2026-10-16 进链：审计 G39 —— 一条没人跑的验收等于没有）
  "pnpm verify:drive-paths",
  // ② 出产物
  "pnpm build:web",
  "pnpm electron:build",
  /*
   * ⚠️ `cli:build` 与 `verify-cli-npm`（2026-10-16，审计 G40/G95）：**npm 真正发出去的那份 CLI**。
   *
   * 在这之前，CLI 有两条产物、只有一条有门：
   *   · `dist-bin/ding-*.exe`（Bun 单文件）—— 有 `verify-cli-bin.mjs`，但那条既不在 build 链也不在 CI；
   *   · `dist-cli/`（tsc）—— 这才是 `package.json` 里 `bin.ding` 与 `files` 指的东西，
   *     而它**一条门都没有**：不在 build、不在 CI、`verify:artifacts` 也不看它。
   * 代价实测到了（就是加这两步的当口）：`pnpm cli:build` 当时**根本编不过** ——
   * `engine/adapters/sandbox.ts` 用了 Electron 独有的 `process.resourcesPath`，
   * 而 CLI 那份 tsconfig 只带 `@types/node`。没人跑，所以没人知道。
   */
  "pnpm cli:build",
  /*
   * ⚠️ 打包**不能**直接 `electron-builder`（2026-10-14 修）：
   * 必须先 `node scripts/stage-app.mjs` 摆一个只装生产依赖的 app 目录，
   * 而且 `build.files` 里对 node_modules 要走对象形态（原样拷、绕开收集器）——
   * 否则嵌套依赖副本会漏进不了包，**打出来的应用启动即崩**
   * （`Cannot find module 'readable-stream/passthrough'`，开发态看不到）。
   * 详见 `.npmrc` 顶部与 `scripts/stage-app.mjs` 的文件头。
   */
  "pnpm package:win",
  // ③ 拿产物去验（顺序不可换：产物先出来）
  "node scripts/verify-artifacts.mjs",
  "node scripts/verify-packaged.mjs",
  /* npm 那份 CLI 产物级端到端：跑它自己的 --help/sessions/models/doctor/eval，并与源树对照 */
  "node scripts/verify-cli-npm.mjs",
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
    expect(at("pnpm typecheck"), "typecheck 必须在打包之前").toBeLessThan(at("pnpm package:win"));
    expect(at("pnpm lint"), "lint 必须在打包之前").toBeLessThan(at("pnpm package:win"));
    expect(at("pnpm test"), "test 必须在打包之前").toBeLessThan(at("pnpm package:win"));
    // 产物先出来，再拿产物去验
    expect(at("pnpm package:win"), "打包必须在三道门之前").toBeGreaterThan(-1);
    expect(at("scripts/verify-artifacts.mjs")).toBeGreaterThan(at("pnpm package:win"));
    expect(at("scripts/verify-packaged.mjs")).toBeGreaterThan(at("scripts/verify-artifacts.mjs"));
    expect(at("scripts/verify-acceptances.mjs")).toBeGreaterThan(at("scripts/verify-packaged.mjs"));
  });

  it("用 && 串起来（任何一道红就整体失败，不是分号那种'红了也继续'）", () => {
    /*
     * ⚠️ 2026-10-16（审计 G53.u）：原来是 `not.toContain(";")` + `length >= 6` ——
     * 前者挡不住"某两步之间忘了写 `&&`"（那会静默变成一条命令的参数），
     * 后者在步骤表已经逐字断言过的情况下等于同义重复。
     * 现在：**每一步之间恰好一个 `&&`**，且步骤不空、不重复。
     */
    expect(build.split(" && ").length - 1, "步骤之间的 && 数量与步骤数对不上").toBe(got.length - 1);
    expect(got.every((s) => typeof s === "string" && s.trim().length > 0), "步骤表里有空步").toBe(true);
    expect(new Set(got).size, "步骤表里有重复的步").toBe(got.length);
  });

  it("⭐ 两道 CLI 产物门在 CI 里也真的被调用（建好却没人跑的门 = 没有门）", () => {
    /*
     * ⚠️ 审计 G63 的原话是"新产物门建成了却没进任何门禁链" —— 那正是本仓反复清的
     * "一道会悄悄消失的检查"。所以这里不满足于"文件存在"，而是**读 CI 的 workflow**，
     * 要求它真的调用这两条：
     *   · `scripts/verify-cli-npm.mjs`：npm 发出去的 dist-cli（纯 node，CI 的 gates 里跑）；
     *   · `scripts/verify-cli-bin.mjs`：Bun 编的单二进制（单独一个 job，要装 bun）。
     * 谁把它们从 CI 里删掉，这一条就红 —— 改 CI 是有意的工程动作，那就得同时改这里。
     */
    const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    for (const needle of ["scripts/verify-cli-npm.mjs", "scripts/verify-cli-bin.mjs"]) {
      expect(ci, `CI 里没有调用 ${needle}（建好却没人跑的门 = 没有门）`).toContain(needle);
    }
    // 单二进制那条要先有产物：CI 里得真的编（`cli:bin`），不然验的是空气
    expect(ci, "CI 里没有编单二进制（cli:bin）就想去验它 —— 那验的是上一次的旧产物").toContain("cli:bin");
  });

  it("引用的脚本、npm script 与 lint 配置都真的存在（清单指向不存在的东西 = 假门禁）", () => {
    for (const f of [
      "scripts/verify-artifacts.mjs",
      "scripts/verify-packaged.mjs",
      "scripts/verify-acceptances.mjs",
      /* 2026-10-16（审计 G39）：路径校验这条也进了 build 链，一并查在不在 */
      "scripts/verify-drive-paths.ts",
      /* 2026-10-16（审计 G40/G95）：npm 产物那条门 + 它要验的两样东西都得在 */
      "scripts/verify-cli-npm.mjs",
      "scripts/build-cli.mjs",
      "scripts/verify-cli-bin.mjs",
    ]) {
      expect(existsSync(path.join(ROOT, f)), `${f} 不存在（清单指向不存在的东西 = 假门禁）`).toBe(true);
    }
    // 新门引的是 npm script，不是文件 —— 所以这里查 scripts 表
    for (const name of ["typecheck", "lint", "test", "build:web", "electron:build", "cli:build", "cli:release"]) {
      expect(pkg.scripts[name], `package.json 里没有 ${name} 这个 script`).toBeTruthy();
    }
    /*
     * lint 的规则集写在配置文件里，缺了它就退回默认那一大坨。
     *
     * ⚠️ 2026-10-16（审计 P222）：这里原来断言"**恰好**只有 no-undef / no-unused-vars"
     * （注释还写着「B3 明确只开两条」）。那两句话描述的是**缺陷**：
     * `categories.correctness` 被整个关掉，于是所有 correctness 形状
     * （no-dupe-keys / no-self-assign / no-const-assign / no-unreachable / valid-typeof…）
     * 在 CI 里永远不会红 —— 一道看着像门禁的门，实际只挡两件事。
     *
     * 现在升级成**棘轮**（三条，任一被推翻都会红）：
     *   ① 规则集必须等于下面这份**评审过的名单**（增删都要来改这里 = 一次显式决定）；
     *   ② 名单必须包含原来那两条（删掉 no-undef / no-unused-vars 照样红）；
     *   ③ `correctness` 分类必须是开着的（关掉它 = 退回缺陷形状）。
     */
    const rc = JSON.parse(readFileSync(path.join(ROOT, ".oxlintrc.json"), "utf8")) as {
      categories?: Record<string, string>;
      rules?: Record<string, string>;
    };
    /**
     * 评审过的规则集 = **配置文件 `rules` 里逐条写出来的那几个**（`categories.correctness`
     * 牵进来的那一大批不在这个名单里，它们由下面的"没被显式关掉"那条断言看着）。
     *
     * 增删一条都要来改这里，并说明它拦的是什么形状 —— 这是"改动可见"的落点。
     */
    const REVIEWED_RULES = [
      "no-undef", // 原来就有：用了没定义的标识符
      "no-unused-vars", // 原来就有：死变量 / 死导入
      /* ↓ 这 9 条是**显式关掉**的风格类（豁免，理由见 `src/lintGate.test.ts` 的 ALLOWED_OFF） */
      "no-control-regex",
      "no-irregular-whitespace",
      "no-unsafe-optional-chaining",
      "no-constant-binary-expression",
      "no-useless-escape",
      "unicorn/no-useless-fallback-in-spread",
      "unicorn/no-useless-length-check",
      "unicorn/no-useless-spread",
      "unicorn/prefer-string-starts-ends-with",
    ];
    const configured = Object.keys(rc.rules ?? {}).sort();
    expect(configured, "lint 规则集与评审过的名单不一致（增删规则都要在同一次改动里改这里）").toEqual(
      [...new Set(REVIEWED_RULES)].sort(),
    );
    for (const must of ["no-undef", "no-unused-vars"]) {
      expect(configured, `lint 规则集里少了 ${must} —— 它是原来那两条之一`).toContain(must);
    }
    /*
     * ⚠️ 这一批由 `categories.correctness` 提供（不写进 `rules`），所以按**没被显式关掉**判 ——
     * 它们是 P222 点名的那几个形状，一条被 `off` 掉就等于那类缺陷重新变得看不见。
     */
    for (const key of ["no-dupe-keys", "no-self-assign", "no-const-assign", "no-unreachable", "valid-typeof"]) {
      expect(rc.rules?.[key], `${key} 被显式关掉了 —— 它是 P222 点名的形状`).not.toBe("off");
    }
    expect(rc.categories?.correctness, "correctness 分类被关掉了：门禁又只剩两条规则（审计 P222）").toBe("error");
  });
});
