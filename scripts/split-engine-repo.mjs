/**
 * **把引擎包拆成独立仓**（V5-4「engine 独立仓」那一格）。
 *
 * 它在**一个新目录**里建一个 git 仓，只放"引擎包"要的那几样：
 *   · `packages/`（engine-core + engine，各自自带 package.json / README / tsconfig）
 *   · 它们 import 的源码（engine/、shared/、hosts/cli 的装配与执行体）
 *   · RELEASE.md（发布策略）+ LICENSE
 *
 * ⚠️ 这一脚本**只在本机建仓**（`git init` + 一次初始提交），不碰任何远端 ——
 * "公开一个新仓"是外部动作，要人拍（与 `RELEASE.md` 里 npm 发布那一条同一个口径）。
 *
 * 用法：`node scripts/split-engine-repo.mjs <目标目录>`
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target) {
  console.error("用法：node scripts/split-engine-repo.mjs <目标目录>");
  process.exit(1);
}
if (existsSync(target)) {
  console.error(`目标目录已经在了：${target}（换个名字，脚本不删已有的东西）`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });
const copy = (rel) => cpSync(path.join(ROOT, rel), path.join(target, rel), { recursive: true });
for (const rel of ["engine", "shared", "packages", "hosts/cli", "examples/sdk-turn", "LICENSE"]) copy(rel);
writeFileSync(path.join(target, "RELEASE.md"), readFileSync(path.join(ROOT, "RELEASE.md")));
/* 产物与依赖不进新仓 */
writeFileSync(path.join(target, ".gitignore"), "node_modules/\npackages/*/dist/\ndist/\n*.tgz\n");
execFileSync("git", ["init", "-q"], { cwd: target });
execFileSync("git", ["add", "-A"], { cwd: target });
execFileSync("git", ["-c", "user.name=dsh", "-c", "user.email=dsh@local", "commit", "-q", "-m", "引擎包：v0.1.0（从主仓拆出）"], { cwd: target });
console.log(`✓ 独立仓建好：${target}（本地 git 仓，未推任何远端）`);
console.log("  要公开它：在新目录里 `git remote add origin <url>` 再 push（外部动作，请人拍）");
rmSync(path.join(target, ".git", "index.lock"), { force: true });
