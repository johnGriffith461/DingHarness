import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 验证单二进制（Phase 11.1 的验收）。
 *
 * ## 判据
 *
 * 方案 11.1 的验收是「**三平台单文件可执行；无 Node 环境的机器跑通 `ding run`**」。
 * 这一条能验 Windows x64 那个（本机就是它），另外三个只能编、不能跑 ——
 * 这一点写在产物旁边的 `BUILD-NOTES.md` 里，也写在这里的报告里。
 *
 * ## 怎么算"无 Node 环境"
 *
 * 不能真把 Node 卸了。可行的近似：**把 PATH 剥到只剩系统目录**再跑那个 exe ——
 * 如果它还需要 PATH 上的 `node`，这里就会失败。Bun 编出来的产物把 runtime 打进去了，
 * 所以它不需要。
 *
 * ## 最有力的一条：让它跑**离线评测集**
 *
 * `ding eval` 一条模型都不调，却会把**整条链**走一遍：CLI 解析 → 装配（含 SQLite）→
 * 引擎 → 工具 → 闸门 → 事件 → 投影。跑通就说明这个单文件里内核是完整可用的，
 * 而不是"能打印 --help 而已"。
 *
 * 用法：node scripts/verify-cli-bin.mjs
 */

const ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "engine", "eval", "cases.ts"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
})();

const BIN = path.join(ROOT, "dist-bin", "ding-windows-x64.exe");
const bad = [];
const note = (m) => console.log("   " + m);

if (process.platform !== "win32") {
  console.log("（这个脚本验的是 Windows x64 那个产物；当前系统不是 win32，跳过）");
  process.exit(0);
}
if (!fs.existsSync(BIN)) {
  console.error("✗ 没有 dist-bin/ding-windows-x64.exe —— 先跑 pnpm cli:bin");
  process.exit(1);
}

/** 把 PATH 剥到只剩系统目录（证明它不靠 PATH 上的 node）。 */
function bareEnv() {
  const env = { ...process.env };
  const sys = process.platform === "win32" ? [`${process.env.SystemRoot}\\system32`, process.env.SystemRoot] : ["/usr/bin"];
  env.PATH = sys.filter(Boolean).join(path.delimiter);
  /*
   * 数据目录指到临时位置：这一条是"产物能用吗"，不该碰真实数据。
   *
   * ⚠️ 2026-10-16 修：这里原来写的是 `DH`**S**`_DATA_DIR` —— 而 CLI 读的是 `DH_DATA_DIR`
   * （`hosts/cli/ding.ts` 的 `dataDir()`）。也就是说这句"隔离"从来没生效过：
   * 这条验证一直在拿**用户真实的 `~/.ding`** 跑 sessions/doctor/eval。
   * 这正是本仓反复清的那种"注释声称的与实际做的不一样"。
   */
  env.DH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dh-bin-verify-"));
  return env;
}

function runBin(args, timeoutMs = 300_000) {
  const started = Date.now();
  const got = spawnSync(BIN, args, { cwd: ROOT, encoding: "utf8", env: bareEnv(), timeout: timeoutMs });
  return { ...got, ms: Date.now() - started };
}

/* ① 它自己就是可执行的（不需要 `node` 这个词出现在命令行里） */
{
  const got = runBin(["--help"], 60_000);
  if (got.status !== 0) bad.push(`--help 退出码 ${got.status}：${(got.stderr ?? "").slice(0, 120)}`);
  else if (!/ding —— Ding Harness/.test(got.stdout ?? "")) bad.push("--help 的输出不像 ding 的帮助");
  else note(`--help ✓（${got.ms}ms，PATH 里没有 node）`);
}

/* ② 本地能力：列会话（要真开 SQLite） */
{
  const got = runBin(["sessions", "--json"], 120_000);
  if (got.status !== 0) bad.push(`sessions 退出码 ${got.status}：${(got.stderr ?? "").slice(0, 120)}`);
  else note("sessions ✓（SQLite 在单文件里能开）");
}

/* ③ 模型目录表（要读内置快照） */
{
  const got = runBin(["models"], 60_000);
  if (got.status !== 0 || !/provider|模型/.test(got.stdout ?? "")) bad.push("models 没列出 provider");
  else note("models ✓");
}

/* ④ 自检（Phase 11.4 的命令也要在单文件里可用） */
{
  const got = runBin(["doctor"], 120_000);
  const out = `${got.stdout ?? ""}${got.stderr ?? ""}`;
  if (!/ding doctor/.test(out)) bad.push(`doctor 没在单文件里跑起来：${out.slice(0, 120)}`);
  else note(`doctor ✓（${out.split(String.fromCharCode(10)).filter((l) => l.startsWith("✓") || l.startsWith("✗")).length} 项检查）`);
}

/* ⑤ 最有力的一条：离线评测集跑一遍（整条链都在里面） */
{
  const got = runBin(["eval", "--json"], 600_000);
  const out = `${got.stdout ?? ""}`;
  let report = null;
  try {
    report = JSON.parse(out.slice(out.indexOf("{")));
  } catch {
    /* 下面按"解析不出来"报 */
  }
  if (!report) {
    bad.push(`eval 没给出可解析的报告（退出码 ${got.status}）：${(got.stderr ?? "").slice(0, 160)}`);
  } else if (report.failed > 0) {
    bad.push(`单文件里的评测集有 ${report.failed} 条失败 —— 说明打包后的内核与源码不一致`);
  } else {
    note(`eval ✓ ${report.passed}/${report.total}（单文件里的内核是完整可用的）`);
  }
}

console.log("");
if (bad.length) {
  console.error("✗ 单二进制验证：\n   - " + bad.join("\n   - "));
  process.exitCode = 1;
} else {
  console.log("✓ 单二进制：Windows x64 产物能跑（PATH 剥到只剩系统目录），--help / sessions / models / doctor / eval 五条全通");
  console.log("  ⚠️ 另外三个平台的产物只编出来了、没跑过 —— 见 dist-bin/BUILD-NOTES.md");
}
