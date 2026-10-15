/**
 * 把 `ding` 装成全局命令 —— **双渠道**（Phase 11.2）。
 *
 * 方案 11.2 的原文：「分发双渠道：**安装包 / 一条命令安装脚本为主渠道**；
 * npm bin 保留给 Node 用户，**不强制**」，验收是「安装 → `ding doctor` 全绿」。
 *
 * ## 两条渠道各自适合谁
 *
 * | 渠道 | 给谁 | 目标机器需要什么 | 产物 |
 * |---|---|---|---|
 * | **单文件可执行**（主渠道） | 不想装 Node 的人 | **什么都不用装** | `dist-bin/ding-<平台>` |
 * | npm bin（保留） | 已经有 Node 的人、要改代码的人 | Node ≥ 24 | `dist-cli/` + `npm link` |
 *
 * ## 为什么不默默替你装
 *
 * 默认**只构建并打印命令**（与插件安装要 `--yes` 同一口径）：
 * 装全局是对这台机器的改动，不该在"跑一个脚本"的名义下悄悄发生。
 * 要装就显式给 `--bin`（拷单文件到用户 bin 目录）或 `--link`（npm link）。
 *
 * ## 装完必须跑一遍 doctor
 *
 * 验收是"安装 → `ding doctor` 全绿"，所以这里装完**顺手跑一次 doctor**
 * 并把结果打出来（不是"装完就宣布成功"）。doctor 红了也不是安装失败 ——
 * 那说明机器上还缺别的东西（没配 key 之类），它会告诉你下一步。
 *
 * 用法：
 * ```
 * node scripts/install-cli.mjs                 # 只构建，打印两条渠道的装法
 * node scripts/install-cli.mjs --bin           # 装单文件可执行到用户 bin 目录
 * node scripts/install-cli.mjs --link          # npm link（全局命令指向本仓）
 * node scripts/install-cli.mjs --bin --no-doctor   # 装完不自检
 * ```
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const say = (m) => process.stdout.write(m + "\n");

/** 本平台的单文件产物名（与 `build-cli-bin.mjs` 的 TARGETS 对齐）。 */
function binName() {
  if (process.platform === "win32") return "ding-windows-x64.exe";
  if (process.platform === "darwin") return process.arch === "arm64" ? "ding-darwin-arm64" : "ding-darwin-x64";
  return "ding-linux-x64";
}

/** 用户级 bin 目录（不放系统目录：不需要管理员权限，也不用碰 /usr/local）。 */
function userBinDir() {
  if (process.platform === "win32") return path.join(os.homedir(), ".ding", "bin");
  return path.join(os.homedir(), ".local", "bin");
}

/** 这个目录在不在 PATH 上（决定要不要提醒用户）。 */
function onPath(dir) {
  const parts = (process.env.PATH ?? "").split(path.delimiter).map((p) => p.replace(/[\\/]+$/, "").toLowerCase());
  return parts.includes(dir.replace(/[\\/]+$/, "").toLowerCase());
}

/** 装单文件可执行；成功返回**装上去那个文件的绝对路径**（自检要用它）。 */
function installBin() {
  const src = path.join(ROOT, "dist-bin", binName());
  if (!existsSync(src)) {
    say(`[install-cli] 没有单文件产物 ${path.relative(ROOT, src)} —— 先跑 \`pnpm cli:bin\``);
    return "";
  }
  const dir = userBinDir();
  const target = path.join(dir, process.platform === "win32" ? "ding.exe" : "ding");
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, target);
  if (process.platform !== "win32") chmodSync(target, 0o755);
  say(`[install-cli] ✓ 已装：${target}`);
  if (!onPath(dir)) {
    say("");
    say(`⚠️ ${dir} 还不在 PATH 上 —— 把下面这行加进环境变量（然后重开终端）：`);
    say(
      process.platform === "win32"
        ? `   setx PATH "%PATH%;${dir}"`
        : `   echo 'export PATH="$PATH:${dir}"' >> ~/.bashrc`,
    );
    say("   （不加也能用：直接敲全路径也行）");
  } else {
    say(`   ${dir} 已在 PATH 上，新开终端敲 \`ding help\` 试试。`);
  }
  return target;
}

/** npm link（Node 用户那条渠道）。 */
function installLink() {
  say("[install-cli] 构建 dist-cli…");
  execFileSync("node", [path.join(ROOT, "scripts", "build-cli.mjs")], { cwd: ROOT, stdio: "inherit" });
  const entry = path.join(ROOT, "dist-cli", "hosts", "cli", "ding.js");
  if (!existsSync(entry)) {
    say("[install-cli] ✗ 产物不在，先看上面的构建输出");
    return false;
  }
  say("[install-cli] npm link…");
  execFileSync(npm, ["link"], { cwd: ROOT, stdio: "inherit" });
  say("[install-cli] ✓ 好了（这条渠道要目标机器有 Node）。");
  return true;
}

/**
 * 装完自检：跑一次 `ding doctor` 并把结果原样打出来。
 *
 * ⚠️ 用**刚装上去的那个命令**跑（`ding`），不是 `node dist-cli/…` ——
 * 要验的正是"装完能不能用"，否则测的是仓库里的源码。
 */
function runDoctor(installedPath) {
  say("");
  say("[install-cli] 自检（ding doctor）…");
  /*
   * ⚠️ 有绝对路径就用绝对路径（刚装的单文件渠道）——PATH 还没生效时敲 `ding` 会拿到
   * cmd 的"不是内部或外部命令"，那是**装完立刻验**这个场景里的常态，
   * 用绝对路径跑才不会把"PATH 没生效"误报成"自检有问题"（第一版就这么误报过）。
   */
  const cmd = installedPath || (process.platform === "win32" ? "ding.exe" : "ding");
  const got = spawnSync(cmd, ["doctor"], { encoding: "utf8" });
  const out = `${got.stdout ?? ""}${got.stderr ?? ""}`.trim();
  if (!out && got.error) {
    say(`  跑不起来（${got.error.message}）—— 若刚装完，重开一个终端再试`);
    return false;
  }
  say(out.split("\n").map((l) => "  " + l).join("\n"));
  say(
    got.status === 0
      ? "  → 自检全绿，装好了。"
      : "  → 自检有待处理项（上面每一项都写了下一步）。**安装本身是成功的**，缺的是 key 之类。",
  );
  return true;
}

/* ────────────────────── 入口 ────────────────────── */

const wantBin = process.argv.includes("--bin");
const wantLink = process.argv.includes("--link");
const skipDoctor = process.argv.includes("--no-doctor");

if (!wantBin && !wantLink) {
  // 默认：把两条渠道都告诉他，但不替他决定
  const built = readdirSync(path.join(ROOT, "dist-bin"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith("ding-"))
    .map((e) => e.name);
  say("[install-cli] 两条渠道，按需选一条：");
  say("");
  say("  ① 单文件可执行（不想装 Node 的机器用这条）");
  say("      node scripts/install-cli.mjs --bin");
  say(built.length ? `      （已有产物：${built.join(" / ")}）` : "      （还没有产物：先跑 pnpm cli:bin）");
  say("");
  say("  ② npm bin（已经有 Node、或者要改代码的用这条）");
  say("      node scripts/install-cli.mjs --link");
  say("");
  say("  安装是对这台机器的改动，所以脚本不替你敲 —— 这与插件安装要 --yes 同一个口径。");
  say("  装完会自动跑一次 `ding doctor`（方案 11.2 的验收）。");
  process.exit(0);
}

let ok = true;
let installedPath = "";
if (wantBin) {
  installedPath = installBin();
  ok = Boolean(installedPath) && ok;
}
if (wantLink) ok = installLink() && ok;
if (ok && !skipDoctor) runDoctor(installedPath);
process.exit(ok ? 0 : 1);
