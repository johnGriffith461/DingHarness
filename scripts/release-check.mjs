#!/usr/bin/env node
/**
 * **发版前的机械核对**（E01 的准备；它不发布、不改任何文件）。
 *
 * ```bash
 * node scripts/release-check.mjs                 # 按当前版本号核对（轨道自动判断）
 * node scripts/release-check.mjs --stable        # 断言这是 stable（不许预发布后缀）
 * node scripts/release-check.mjs --nightly       # 断言这是 nightly 形状
 * ```
 *
 * 核对的都是**机器能判、且最常漏**的四件：
 *   ① 三份版本文件一致（`shared/version.json` / `package.json` / `packages/cli/package.json`）；
 *   ② 版本形状与要发的轨道相符；
 *   ③ CHANGELOG 最上面的发布段就绪（「未发布」或含这次版本号）；
 *   ④ 构建产物存在（`dist` / `dist-electron` / `dist-cli`）—— 发布的是产物，不是源码。
 *
 * 判据在 `shared/release.ts`（有单测）；这里只做 IO 与输出。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

let checkVersionSet;
let checkChangelogHeading;
try {
  ({ checkVersionSet, checkChangelogHeading } = await import(
    pathToFileURL(path.join(ROOT, "shared", "release.ts")).href
  ));
} catch (error) {
  if (/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|Unexpected token/i.test(String(error?.message ?? error))) {
    console.error(`这个脚本要用 Node 22.6+（类型剥离）；当前是 ${process.version}。改用：pnpm tsx scripts/release-check.mjs`);
    process.exit(1);
  }
  throw error;
}

const mode = argv.includes("--stable") ? "stable" : argv.includes("--nightly") ? "nightly" : "any";

const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
const versionFiles = [];
for (const [rel, pick] of [
  ["shared/version.json", (o) => o.version],
  ["package.json", (o) => o.version],
  ["packages/cli/package.json", (o) => o.version],
]) {
  try {
    const version = pick(readJson(rel));
    if (typeof version === "string") versionFiles.push({ file: rel, version });
  } catch {
    /* 这个形态没有那份文件（例如独立仓）：跳过 */
  }
}

const problems = [];
const versions = checkVersionSet(versionFiles, mode);
if (!versions.ok) problems.push(...versions.problems);
const version = versions.ok ? versions.version : "";

const changelogFile = path.join(ROOT, "CHANGELOG.md");
if (existsSync(changelogFile)) {
  const heading = checkChangelogHeading(readFileSync(changelogFile, "utf8"), version || undefined);
  if (!heading.ok && heading.problem) problems.push(heading.problem);
} else {
  problems.push("CHANGELOG.md 不在了");
}

const artifacts = [
  ["dist/index.html", "web"],
  ["dist-electron/electron/main.cjs", "electron"],
  ["dist-cli/hosts/cli/ding.js", "cli"],
];
const missing = artifacts.filter(([rel]) => !existsSync(path.join(ROOT, rel)));
if (missing.length) {
  problems.push(`产物不在：${missing.map(([rel]) => rel).join(" / ")}（先 pnpm build / cli:build）`);
}

console.log(
  JSON.stringify(
    {
      mode,
      version: version || "(不一致)",
      versions: versionFiles,
      artifacts: artifacts.map(([rel, label]) => ({ label, present: existsSync(path.join(ROOT, rel)) })),
      problems,
    },
    null,
    2,
  ),
);

if (problems.length) {
  console.error("✗ 发版核对没过：");
  for (const one of problems) console.error(`  · ${one}`);
  process.exit(1);
}
console.log("✓ 发版核对通过（只核对了机械项；七道门与人工签收仍要按 RELEASE.md 走）");
