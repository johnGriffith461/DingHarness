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
/* 构建与验收要的那几样：包的 tsconfig extends 根那份，两个脚本是"构建 + 打包冒烟"本身 */
for (const rel of ["tsconfig.json"]) copy(rel);
mkdirSync(path.join(target, "scripts"), { recursive: true });
for (const rel of ["scripts/build-sdk.mjs", "scripts/verify-sdk.mjs"]) copy(rel);
/*
 * 一份**裁剪过的** package.json：只要 SDK 那两块（typescript / tsx / @types node / vitest 的类型），
 * 不把桌面那一整套（electron / react / playwright）拖进引擎仓。
 */
writeFileSync(
  path.join(target, "package.json"),
  JSON.stringify(
    {
      name: "ding-engine",
      version: "0.1.0",
      private: true,
      description: "Ding Harness 的引擎与 SDK（ding-engine-core / ding-engine）",
      license: "Apache-2.0",
      type: "module",
      scripts: {
        build: "node scripts/build-sdk.mjs",
        verify: "node scripts/build-sdk.mjs && node scripts/verify-sdk.mjs",
      },
      devDependencies: {
        "@types/node": "^22.0.0",
        tsx: "4.23.15",
        typescript: "^5.0.0",
        vitest: "5.0.3",
      },
      dependencies: {
        "@ai-sdk/anthropic": "4.0.79",
        "@ai-sdk/google": "4.0.95",
        "@ai-sdk/openai-compatible": "3.0.67",
        "@ai-sdk/provider": "4.0.26",
        ai: "7.0.137",
        zod: "4.6.6",
      },
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  path.join(target, "README.md"),
  [
    "# ding-engine",
    "",
    "**Ding Harness 的引擎与 SDK**：事件溯源内核 + Node 侧完整能力面。",
    "",
    "| 包 | 是什么 |",
    "|---|---|",
    "| `ding-engine-core` | 最小嵌入面：事件模型 + 主循环（**无 IO**） |",
    "| `ding-engine` | 完整能力面：最小面 + SQLite / 工具执行体 / 凭据库 / 插件 / 装配 |",
    "",
    "这个仓是从主仓 `DingHarness` **拆出来的**（`scripts/split-engine-repo.mjs`）：",
    "同一份代码、同一套测试口径 —— 主仓的 CI 每 push 都跑 `pnpm verify:sdk`",
    "（两个包真构建 → 真打包 → 干净工程里跑通两种用法）。",
    "",
    "```bash",
    "pnpm install",
    "pnpm verify          # 构建两个包 + 打包冒烟（零出网：假模型端点）",
    "```",
    "",
    "十分钟上手：[`examples/sdk-turn/README.md`](examples/sdk-turn/README.md)。",
    "版本与发布口径：[`RELEASE.md`](RELEASE.md)（破坏性变更要 ADR + major + 迁移指南）。",
    "",
    "## 边界（如实说）",
    "",
    "- 这个仓**不含**桌面与 CLI 宿主（它们在主仓）；这里只有引擎、SDK 与最小示例。",
    "- 主仓是唯一开发处，这里是**发布用的拆分**：改代码请改主仓，再按需重新拆。",
    "",
  ].join("\n"),
);

writeFileSync(path.join(target, "RELEASE.md"), readFileSync(path.join(ROOT, "RELEASE.md")));
/* 产物与依赖不进新仓 */
writeFileSync(path.join(target, ".gitignore"), "node_modules/\npackages/*/dist/\ndist/\n*.tgz\n");
execFileSync("git", ["init", "-q"], { cwd: target });
execFileSync("git", ["add", "-A"], { cwd: target });
execFileSync("git", ["-c", "user.name=dsh", "-c", "user.email=dsh@local", "commit", "-q", "-m", "引擎包：v0.1.0（从主仓拆出）"], { cwd: target });
console.log(`✓ 独立仓建好：${target}（本地 git 仓，未推任何远端）`);
console.log("  要公开它：在新目录里 `git remote add origin <url>` 再 push（外部动作，请人拍）");
rmSync(path.join(target, ".git", "index.lock"), { force: true });
