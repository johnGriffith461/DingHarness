/**
 * 把 `ding` 装成全局命令（Phase 9 的分发面）。
 *
 * 做什么：构建 → 在**本机**装（`npm link` 或 `npm i -g .`）。
 *
 * ⚠️ 两条如实说明：
 * 1. **它不改全局环境**除非你显式给 `--link`：默认只构建并打印命令。
 *    安装类动作不该在"跑一个脚本"的名义下悄悄发生（与插件安装要 `--yes` 同一个口径）。
 * 2. **它不发布到 npm**：那需要包名可用 + `npm publish` + 认证。
 *    这一步做到"本机装得上、能用"，发布是另一个决定（`npm publish` 由人来敲）。
 *
 * 用法：
 * ```
 * node scripts/install-cli.mjs           # 只构建，打印怎么装
 * node scripts/install-cli.mjs --link    # 构建后 npm link（全局命令指向本仓）
 * ```
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

process.stdout.write("[install-cli] 构建 CLI…\n");
execFileSync("node", [path.join(ROOT, "scripts", "build-cli.mjs")], { cwd: ROOT, stdio: "inherit" });

const entry = path.join(ROOT, "dist-cli", "hosts", "cli", "ding.js");
if (!existsSync(entry)) {
  console.error("[install-cli] ✗ 产物不在，先看上面的构建输出");
  process.exit(1);
}

if (!process.argv.includes("--link")) {
  process.stdout.write(
    [
      "",
      "[install-cli] 构建好了。要装成全局命令，二选一：",
      "  · 本仓直接链过去（改代码立刻生效，适合开发）：",
      "      npm link",
      "  · 当普通包装上（拷一份进全局，适合自用）：",
      "      npm i -g .",
      "",
      "  两者都要你自己敲 —— 装全局是对这台机器的改动，不该由脚本替你决定。",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

process.stdout.write("[install-cli] npm link…\n");
execFileSync(npm, ["link"], { cwd: ROOT, stdio: "inherit" });
process.stdout.write("[install-cli] ✓ 好了。新开一个终端敲 `ding help` 试试。\n");
