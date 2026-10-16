import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/**
 * 验证 **npm 真正发出去的那份 CLI**（`dist-cli`，tsc 产物）。
 *
 * ## 为什么单开一条（2026-10-16，审计 G40/G95）
 *
 * 仓里原来只有 `scripts/verify-cli-bin.mjs`，它验的是 `dist-bin/ding-*.exe`
 * （Bun 编的单文件）。可 `package.json` 里 `bin.ding` 指的是
 * `dist-cli/hosts/cli/ding.js`（`tsc -p tsconfig.cli.json`），`files` 发的也是 `dist-cli/` 下的全部文件（`dist-cli/` 加通配）
 * —— **被验的产物和发出去的产物不是同一个**，而真正发给用户的那个一条门都没有：
 * 它不在 `pnpm build` 链、不在 CI、`verify:artifacts` 也不看它。
 * 两条产物之所以会分岔，是因为它们的构建路径完全不同（Bun 把一切打进去；tsc 只搬 `.ts`
 * 编出来的 `.js`，**非 TS 的随附文件一个都不会自动带走**）—— 前者能跑不等于后者能跑。
 *
 * ## 判据
 *
 * 用**普通 Node**（不起 Electron、不下载任何东西）跑 `bin.ding` **声明的那个入口**：
 * `--help` / `doctor` / `sessions --json` / `models` / `eval --json`。
 * 最后一条最关键：`eval` 不调模型，但会把**整条链**走一遍（参数解析 → 装配 → SQLite →
 * 引擎 → 工具 → 闸门 → 事件 → 投影），跑通才算"这份产物里的内核是完整的"。
 *
 * 再加两件只有这条门能做的事：
 * - **与源树比一比**：同一份 `eval` 也在源树里跑一次（走 `tsx`），两边的 `total` 必须相等、
 *   都必须 0 失败。只验"产物能跑"还不够 —— 产物少带了一个数据文件（模型快照、评测样本…）
 *   也能打印 `--help`；两边条数一致才说明发出去的内核与仓库里的是同一套。
 * - **入口真在 `files` 的覆盖范围内**（`dist-cli/` 加通配那一条）：`bin` 指着一个发不出去的文件
 *   是"装完就 command not found"，而这件事在本地跑 `pnpm build` 时看不出来。
 *
 * ## 边界（如实记）
 *
 * 这条门**不**验证：`npm i -g` 之后的 PATH/权限问题、真正的 tarball 内容
 * （`npm pack` 会触发 `prepack`，而 `prepack` 会调本脚本 → 递归，所以不在这里做）、
 * 以及 Linux/macOS 上的行为（本机是 Windows；但这条路是纯 Node，不依赖平台产物）。
 *
 * 用法：node scripts/verify-cli-npm.mjs
 */

const ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "engine", "eval", "cases.ts"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
})();

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const bad = [];
const note = (m) => console.log("   " + m);

/** `bin.ding` 声明的入口（**从 package.json 读**，不写死路径 —— 写死就测不到"指错了"这件事）。 */
const BIN_FIELD = pkg.bin?.ding;
if (typeof BIN_FIELD !== "string" || !BIN_FIELD) {
  console.error("✗ package.json 里没有 `bin.ding` —— 那 npm 装完就没有 `ding` 这条命令。");
  process.exit(1);
}
const ENTRY = path.join(ROOT, BIN_FIELD);
const ENTRY_REL = BIN_FIELD.replace(/\\/g, "/");

/* ① 入口存在，且落在 `files` 的覆盖范围里（`bin` 指着一个发不出去的文件 = 装完即找不到） */
{
  if (!fs.existsSync(ENTRY)) {
    console.error(`✗ 入口不存在：${ENTRY_REL}\n   先跑 \`pnpm cli:build\`（tsc -p tsconfig.cli.json）。`);
    process.exit(1);
  }
  /** 极简 glob：只支持 `dir/**` 与 `dir/**\/*`，够判 `files` 这份清单用。 */
  const covered = () =>
    (pkg.files ?? []).some((pattern) => {
      const p2 = String(pattern).replace(/\\/g, "/").replace(/\/\*\*(\/\*)?$/, "");
      return ENTRY_REL === p2 || ENTRY_REL.startsWith(p2 + "/");
    });
  if (!covered(ENTRY_REL)) {
    bad.push(`入口 ${ENTRY_REL} 不在 package.json 的 files 清单里 —— npm 不会发这个文件，装完就没有 ding`);
  } else {
    note(`入口 ${ENTRY_REL} ✓（在 files 的覆盖范围内）`);
  }

  /*
   * ⚠️ 审计 G40 的另一半：`dist-cli/` 里曾经躺着 `src/workbench/**` 这种旧配置的编译残留，
   * 而 `files` 是 `dist-cli/**\/*` 全量发布 —— 残留会被原样发给用户。
   * `build-cli.mjs` 现在编译前先清目录；这条断言钉住"清干净了"。
   */
  if (fs.existsSync(path.join(ROOT, "dist-cli", "src"))) {
    /*
     * ⚠️ 这条断言第一次跑就抓到了真东西（2026-10-16）：`shared/artifactProto.ts` 用
     * `import type` 去借 `src/workbench/artifact.ts` 的类型，协议层于是反向依赖渲染层 ——
     * tsc 把渲染层一起拉进编译图并 emit，`files` 全量发布就把它发给了用户。
     * 根因已修（类型搬回协议层）；`build-cli.mjs` 也改成编译前清目录。
     * 留着这条断言：下一个"顺手 import 一下"会在这里立刻现形。
     */
    bad.push("dist-cli/src 还在 —— 渲染层的编译产物被发进 npm 包了（协议层是不是又反向 import 了 src/？）");
  }
}

/** 剥掉一切网络/模型能力，并把数据目录指到临时位置（**不是** `~/.ding`）。 */
function cleanEnv() {
  const env = { ...process.env };
  env.DH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dh-npm-verify-"));
  env.DSH_NO_REAL_MODEL = "1";
  for (const k of Object.keys(env)) if (/_API_KEY$/.test(k)) delete env[k];
  return env;
}

/** 用当前 Node 跑**产物里的入口**（跟用户 `npm i -g` 之后那条路一致）。 */
function runArtifact(args, timeoutMs = 300_000) {
  const started = Date.now();
  const got = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: cleanEnv(),
    timeout: timeoutMs,
  });
  return { ...got, ms: Date.now() - started };
}

/** 用 tsx 跑**源树**（拿来做"产物与源码一致"的对照）。 */
function runSource(args, timeoutMs = 300_000) {
  const require = createRequire(import.meta.url);
  let tsx;
  try {
    tsx = require.resolve("tsx/cli");
  } catch {
    return { status: null, stdout: "", stderr: "找不到 tsx（devDependency）—— 这条对照要在仓库里跑", ms: 0, missingTsx: true };
  }
  const started = Date.now();
  const got = spawnSync(process.execPath, [tsx, "hosts/cli/ding.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: cleanEnv(),
    timeout: timeoutMs,
  });
  return { ...got, ms: Date.now() - started };
}

function out(got) {
  return `${got.stdout ?? ""}${got.stderr ?? ""}`;
}

/* ② 它自己就是可执行的入口（`node <bin.ding>` 能起来） */
{
  const got = runArtifact(["--help"], 60_000);
  if (got.status !== 0) bad.push(`--help 退出码 ${got.status}：${out(got).slice(0, 160)}`);
  else if (!/ding —— Ding Harness/.test(got.stdout ?? "")) bad.push("--help 的输出不像 ding 的帮助");
  else note(`--help ✓（${got.ms}ms）`);
}

/* ③ 本地能力：列会话（要真开 SQLite） */
{
  const got = runArtifact(["sessions", "--json"], 120_000);
  if (got.status !== 0) bad.push(`sessions 退出码 ${got.status}：${out(got).slice(0, 160)}`);
  else note("sessions ✓（SQLite 在这份产物里能开）");
}

/* ④ 模型目录表（要读**随附的**模型快照 —— tsc 不会自动带走非 TS 文件，正是这条能抓到） */
{
  const got = runArtifact(["models"], 60_000);
  if (got.status !== 0 || !/provider|模型/.test(out(got))) bad.push(`models 没列出 provider：${out(got).slice(0, 160)}`);
  else note("models ✓（随附的模型快照在产物里）");
}

/* ⑤ 自检 */
{
  const got = runArtifact(["doctor"], 120_000);
  if (!/ding doctor/.test(out(got))) bad.push(`doctor 没跑起来：${out(got).slice(0, 160)}`);
  else {
    const lines = out(got).split("\n").filter((l) => l.startsWith("✓") || l.startsWith("✗"));
    note(`doctor ✓（${lines.length} 项检查）`);
  }
}

/* ⑥ 整条链：离线评测集 —— 并且与源树对照 */
{
  const gotArtifact = runArtifact(["eval", "--json"], 600_000);
  const parse = (text) => {
    const i = text.indexOf("{");
    if (i < 0) return null;
    try {
      return JSON.parse(text.slice(i));
    } catch {
      return null;
    }
  };
  const a = parse(gotArtifact.stdout ?? "");
  /* 失败的用例**点名**：只说"1 条失败"没法诊断（也分不清是产物真差异还是环境抖动）。 */
  const failingCases = (report) =>
    (report?.cases ?? [])
      .filter((c) => c.passed === false || c.ok === false)
      .map((c) => c.name ?? c.id ?? JSON.stringify(c).slice(0, 60));
  if (!a) {
    bad.push(`产物 eval 没给出可解析的报告（退出码 ${gotArtifact.status}）：${out(gotArtifact).slice(0, 160)}`);
  } else if (a.failed > 0) {
    bad.push(`产物里的评测集有 ${a.failed} 条失败 —— 说明发出去的 CLI 与源码不一致：${failingCases(a).join(" / ")}`);
  } else {
    note(`产物 eval ✓ ${a.passed}/${a.total}（${gotArtifact.ms}ms）`);
  }

  const gotSource = runSource(["eval", "--json"], 600_000);
  const b = parse(gotSource.stdout ?? "");
  if (gotSource.missingTsx) {
    bad.push("跑不了源树对照：找不到 tsx（这条门要在仓库里跑，devDependencies 要装齐）");
  } else if (!b) {
    bad.push(`源树 eval 没给出可解析的报告（退出码 ${gotSource.status}）：${out(gotSource).slice(0, 160)}`);
  } else if (b.failed > 0) {
    bad.push(`源树里的评测集自己就有 ${b.failed} 条失败 —— 先修源码再谈产物：${failingCases(b).join(" / ")}`);
  } else if (a && (a.environment > 0 || b.environment > 0)) {
    /*
     * 装置不可达（本机回环那一会儿不通）：这一批的结论**不成立**，
     * 不能拿它去比"产物与源树是否一致" —— 如实报红、让人重跑。
     */
    bad.push(
      `这一跑有装置不可达的用例（产物 ${a.environment} 条、源树 ${b.environment} 条）—— 结论不成立，重跑一次`,
    );
  } else if (a && (a.failed > 0 || a.total !== b.total || a.passed !== b.passed)) {
    /*
     * ⚠️ 这一条是"产物与源树一致"的**唯一**判据：产物少带了一个随附文件（模型快照、评测样本…）、
     * 或者 tsc 把某个分支编丢了时，`--help` 照样能用，只有两边**结果对不上**才露出来。
     */
    bad.push(`产物与源树对不上：产物 ${a.passed}/${a.total}（失败 ${a.failed}）vs 源树 ${b.passed}/${b.total}`);
  } else if (a) {
    note(`与源树一致 ✓ 两边都是 ${a.passed}/${a.total}、0 失败`);
  }
}

console.log("");
if (bad.length) {
  console.error("✗ npm 产物（dist-cli）验证：\n   - " + bad.join("\n   - "));
  process.exitCode = 1;
} else {
  console.log("✓ npm 产物：dist-cli（bin.ding 声明的那个入口）能用普通 Node 跑通，--help / sessions / models / doctor / eval 五条全通，且与源树同一套内核");
}
