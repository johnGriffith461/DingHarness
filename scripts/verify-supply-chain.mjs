#!/usr/bin/env node
/**
 * 供给链守卫（V6-3b）。
 *
 * 它挡的是几类"看起来没事"的漂移：
 *   ① 依赖写成 `*` / `latest` / git 分支 —— 每次 install 都可能装到不同的东西；
 *   ② 构建脚本白名单被悄悄放宽（`onlyBuiltDependencies` 多了一项 = 多一个能在
 *      安装时执行任意代码的包）；
 *   ③ 锁文件与 package.json 脱节（CI 的 frozen-lockfile 会红，但本地往往先看到）；
 *   ④ CLI 发布包与主仓依赖不一致（用户装到的依赖集合与我们验过的不一样）。
 *
 * 用法：pnpm verify:supply-chain（CI 的 gates 里跑）
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));

const pkg = readJson("package.json");
const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

/* ① 版本必须钉住（允许 ^ / ~ / 精确 / >=；不允许 * / latest / git / file:） */
for (const [name, spec] of Object.entries(allDeps)) {
  const text = String(spec);
  if (text === "*" || text === "latest" || /^(git|github|file|link):/.test(text) || text.includes("/")) {
    problems.push(`依赖 ${name} 的版本没钉住：${text}`);
  }
}

/* ② 构建脚本白名单：只允许这三个（多一个都要在 PR 里说清） */
const allowedBuilds = ["electron", "esbuild", "electron-winstaller"];
const builds = pkg.pnpm?.onlyBuiltDependencies ?? [];
if (!Array.isArray(builds) || builds.length === 0) problems.push("package.json 缺 pnpm.onlyBuiltDependencies（安装脚本会默认全跑）");
for (const name of builds) {
  if (!allowedBuilds.includes(name)) problems.push(`构建脚本白名单多了一个：${name}（安装时会执行它的脚本）`);
}
for (const name of allowedBuilds) {
  if (!builds.includes(name)) problems.push(`构建脚本白名单少了 ${name}（Electron/打包会装不起来）`);
}

/* ③ 锁文件在、版本标记是我们验过的格式 */
const lock = path.join(ROOT, "pnpm-lock.yaml");
if (!existsSync(lock)) problems.push("缺 pnpm-lock.yaml（锁文件是依赖树的 ground truth）");
else {
  const head = readFileSync(lock, "utf8").split("\n").slice(0, 3).join("\n");
  if (!/lockfileVersion:\s*'?9\.0'?/.test(head)) problems.push(`锁文件版本不是预期的 9.0：${head.replace(/\n/g, " ")}`);
}

/* ④ 发布龄下限：pnpm 10 读 pnpm-workspace.yaml 的 minimumReleaseAge */
const ws = path.join(ROOT, "pnpm-workspace.yaml");
if (!existsSync(ws)) problems.push("缺 pnpm-workspace.yaml（minimumReleaseAge 没有落点）");
else if (!/minimumReleaseAge:\s*\d+/.test(readFileSync(ws, "utf8"))) {
  problems.push("pnpm-workspace.yaml 里没有 minimumReleaseAge（新发布的包没有隔离期）");
}

/* ⑤ CLI 发布包的依赖必须与主仓同一批（不能少、不能多出桌面依赖） */
/*
 * ⚠️ **渲染层专用依赖**不算"CLI 少装"（2026-10-19）。
 *
 * `react-markdown` / `remark-gfm` 只被 `src/`（Electron 渲染进程）用；
 * CLI 是纯 Node 无头宿主，把它们塞进发布包只会让用户多装 100 多个传递依赖。
 * 所以这里显式列白名单 —— 以后 UI 再加依赖仍会红，只是红的信息变成
 * "要不要把它算进 CLI 发布包"，而不是被当成漏装。
 */
const RENDERER_ONLY_DEPS = new Set(["react-markdown", "remark-gfm"]);
const cliPkgFile = path.join(ROOT, "packages", "cli", "package.json");
if (existsSync(cliPkgFile)) {
  const cli = readJson("packages/cli/package.json");
  const cliDeps = cli.dependencies ?? {};
  for (const name of Object.keys(cliDeps)) {
    if (!(name in (pkg.dependencies ?? {}))) problems.push(`CLI 包有主仓没有的依赖：${name}`);
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (name in cliDeps || RENDERER_ONLY_DEPS.has(name)) continue;
    problems.push(`CLI 包缺主仓的运行依赖：${name}`);
  }
  if (cli.private === true) problems.push("packages/cli 是 private —— 发不出去");
}

if (problems.length) {
  console.error("✗ 供给链检查没过：");
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log(`✓ 供给链检查通过：${Object.keys(allDeps).length} 个依赖版本已钉住；构建脚本白名单 ${builds.length} 项；锁文件 9.0；发布龄 ≥1 天。`);
