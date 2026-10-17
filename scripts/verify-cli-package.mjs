#!/usr/bin/env node
/**
 * `packages/cli` 发布包的守卫（V6-3a）。
 *
 * 它挡的是"发出去才发现"的那类错：
 *   · `bin` 指向的文件不在 `files` 白名单里（装完 `ding` 命令不存在）；
 *   · bin 没有 shebang（装完执行报权限/格式错）；
 *   · 包里混进 `src/` 渲染层或 Electron 依赖；
 *   · 依赖清单为空（装完 import 不到 `ai`）。
 *
 * 用法：pnpm cli:pkg:check（先 `pnpm cli:pkg`）
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "packages", "cli");
const problems = [];

const pkgFile = path.join(PKG, "package.json");
if (!existsSync(pkgFile)) {
  console.error("缺 packages/cli/package.json");
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));

if (typeof pkg.name !== "string" || !pkg.name) problems.push("name 必填");
if (!/^\d+\.\d+\.\d+/.test(String(pkg.version ?? ""))) problems.push(`version 不是 semver：${pkg.version}`);
if (pkg.private === true) problems.push("private: true —— npm 会拒绝发布");

const binRel = pkg.bin?.ding;
if (!binRel) problems.push("bin.ding 必填");
else {
  if (binRel.startsWith("./") || binRel.startsWith("../") || path.isAbsolute(binRel)) {
    problems.push(`bin 必须是包内相对路径（当前：${binRel}）`);
  }
  if (!Array.isArray(pkg.files) || !pkg.files.some((glob) => binRel.startsWith(glob.replace(/\/\*\*\/\*$/, "/")))) {
    problems.push(`bin（${binRel}）不在 files 白名单覆盖范围内`);
  }
  const binFile = path.join(PKG, binRel);
  if (!existsSync(binFile)) problems.push(`bin 文件不存在：${binRel}（先 pnpm cli:pkg）`);
  else {
    const first = readFileSync(binFile, "utf8").split("\n")[0] ?? "";
    if (!first.startsWith("#!/usr/bin/env node")) problems.push(`bin 首行不是 shebang：${first.slice(0, 40)}`);
  }
}

const deps = Object.keys(pkg.dependencies ?? {});
if (!deps.length) problems.push("dependencies 为空 —— 装完会 import 不到 ai/@ai-sdk/*");
for (const forbidden of ["electron", "electron-builder", "react", "vite"]) {
  if (deps.includes(forbidden)) problems.push(`依赖里不该有 ${forbidden}（那是桌面/构建依赖）`);
}

const dist = path.join(PKG, "dist-cli");
if (!existsSync(dist)) problems.push("缺 dist-cli/（先 pnpm cli:pkg）");
else {
  /* 渲染层与桌面进程不该进 CLI 包 */
  for (const bad of ["src", "electron", "dist-electron"]) {
    if (existsSync(path.join(dist, bad))) problems.push(`dist-cli 里混进了 ${bad}/（CLI 包不该带它）`);
  }
  /* 冒烟：入口能在包里被 Node 读到（不真跑 —— 它要 node_modules） */
  const entry = path.join(dist, "hosts", "cli", "ding.js");
  if (!existsSync(entry)) problems.push("dist-cli 里没有 hosts/cli/ding.js");
}

if (problems.length) {
  console.error("✗ packages/cli 不能发布：");
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

let files = 0;
let bytes = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else {
      files += 1;
      bytes += st.size;
    }
  }
};
walk(dist);
console.log(`✓ packages/cli 可发布：${pkg.name}@${pkg.version}，${files} 个文件 / ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  发布：cd packages/cli && npm publish（包名 ${pkg.name}，见 PUBLISHING.md）`);
