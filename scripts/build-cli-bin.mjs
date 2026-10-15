import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 把 CLI 编成**单文件可执行**（Phase 11.1）。
 *
 * ## 为什么用 Bun 编，而不是 Node SEA
 *
 * 方案 §3 的语言决策里定的就是这条（"Rust 重写真正买到的东西有更便宜替代：
 * 单二进制分发 → Bun 编译"）。Bun 把 runtime 打进去，产物是一个
 * **不需要目标机器装 Node** 的文件。
 *
 * ## 前置冒烟门（方案 11.1 原文）
 *
 * 「node:sqlite 在 Bun runtime 正常工作 —— 不通过则经冻结端口换 `bun:sqlite` 实现」。
 * 实测：**不通过**（`No such built-in module: node:sqlite`），
 * 所以驱动已经换成 `bun:sqlite`（见 `engine/adapters/sqliteDriver.ts`）。
 * 这一步在编译**之前**再验一次 —— 门不过就不出产物，别把坏东西发出去。
 *
 * ## 三平台
 *
 * `--target=bun-windows-x64 / bun-darwin-x64+arm64 / bun-linux-x64`。
 * ⚠️ 如实记：本机只能**验证** Windows x64 那个（跑得起来）；
 * 另外三个能编出来，但**没在对应系统上跑过** —— 产物旁边会写一份 `BUILD-NOTES.md` 说明这一点。
 *
 * 用法：pnpm cli:bin（可选 --only win）
 */

const ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "engine", "eval", "cases.ts"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
})();

const OUT_DIR = path.join(ROOT, "dist-bin");
const ENTRY = path.join(ROOT, "hosts", "cli", "ding.ts");

/** 目标平台 → 产物名。 */
const TARGETS = [
  { target: "bun-windows-x64", file: "ding-windows-x64.exe", verifiable: true },
  { target: "bun-darwin-x64", file: "ding-darwin-x64", verifiable: false },
  { target: "bun-darwin-arm64", file: "ding-darwin-arm64", verifiable: false },
  { target: "bun-linux-x64", file: "ding-linux-x64", verifiable: false },
];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
}

/** 门①：bun 在不在。 */
function checkBun() {
  const got = run("bun", ["--version"]);
  if (got.status !== 0) {
    console.error("✗ 没有 bun（单二进制这条路要它）。装：https://bun.sh");
    console.error("  只想用 Node 跑 CLI 的话：pnpm cli:build && node scripts/install-cli.mjs");
    return null;
  }
  return (got.stdout ?? "").trim();
}

/**
 * 门②（方案 11.1 的前置冒烟门）：**冻结端口在 Bun 下真的能用**。
 *
 * 验的不是"bun:sqlite 存在"，而是"存储层那条路能建库、写、读回来" ——
 * 端口能用的判据是**行为**，不是模块在不在。
 */
function checkPortUnderBun() {
  const probe = path.join(ROOT, ".verify", "cli-bin-port-probe.ts");
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  fs.writeFileSync(
    probe,
    `import { createSqliteSessionStore } from "../engine/adapters/sqliteStore";
const dir = process.env.TEMP + "/dh-bin-probe-" + Date.now();
const store = createSqliteSessionStore(dir);
await store.append("s1", [{ requestId: "r1", type: "request", provider: "p", model: "m", messages: [], toolPolicy: "全部允许", tools: [] }]);
const got = await store.load("s1");
store.close();
if (got.records.length !== 1) { console.error("端口在 bun 下不工作：读到 " + got.records.length + " 条"); process.exit(1); }
console.log("端口冒烟：bun 下建库/写/读都通（" + (process.versions.bun ? "bun:sqlite" : "node:sqlite") + "）");
`,
    "utf8",
  );
  const got = run("bun", [probe]);
  const out = `${got.stdout ?? ""}${got.stderr ?? ""}`.trim();
  if (got.status !== 0) {
    console.error("✗ 前置冒烟门没过 —— 不出产物。");
    console.error(out.split("\n").slice(0, 8).join("\n"));
    return false;
  }
  console.log("✓ " + out.split("\n").at(-1));
  return true;
}

function main() {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const version = checkBun();
  if (!version) process.exit(1);
  console.log(`bun ${version}`);
  if (!checkPortUnderBun()) process.exit(1);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const built = [];
  for (const { target, file, verifiable } of TARGETS) {
    if (only === "win" && target !== "bun-windows-x64") continue;
    const out = path.join(OUT_DIR, file);
    process.stdout.write(`编 ${target} … `);
    const got = run("bun", ["build", "--compile", `--target=${target}`, ENTRY, "--outfile", out]);
    if (got.status !== 0) {
      console.log("✗");
      console.error((got.stderr ?? "").split("\n").slice(0, 6).join("\n"));
      continue;
    }
    const bytes = fs.statSync(out).size;
    built.push({ target, file, mb: bytes / 1024 / 1024, verifiable });
    console.log(`✓ ${file}  ${(bytes / 1024 / 1024).toFixed(1)}MB`);
  }

  if (!built.length) {
    console.error("一个产物都没出来。");
    process.exit(1);
  }

  /*
   * 产物旁边留一份说明：哪个**跑过**、哪个只是编出来了。
   * 不写这一句的话，下一个人会以为四个都验过。
   */
  fs.writeFileSync(
    path.join(OUT_DIR, "BUILD-NOTES.md"),
    [
      "# 单二进制产物（Phase 11.1）",
      "",
      `bun ${version} 编出，时间 ${new Date().toISOString()}。`,
      "",
      "| 产物 | 目标 | 大小 | 在本机跑过吗 |",
      "|---|---|---|---|",
      ...built.map((b) => `| \`${b.file}\` | ${b.target} | ${b.mb.toFixed(1)}MB | ${b.verifiable ? "**跑过**（冒烟验过）" : "**没跑过**（编出来了，但本机不是那个系统）"} |`),
      "",
      "## 如实记下的边界",
      "",
      "- 只有 Windows x64 那个在本机真的跑过（`node scripts/verify-cli-bin.mjs`）。",
      "  另外三个**能编出来**，但没在对应系统上执行过 —— 这是「三平台验收」的一部分缺口，不是「已验证」。",
      "- 单二进制**不需要目标机器装 Node**；它把 runtime 打进去了。",
      "- 它读的配置与数据目录跟 `pnpm ding` 完全一样（`~/.ding/`），所以两个跑法可以混用。",
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`\n产物在 ${path.relative(ROOT, OUT_DIR)}/ ，说明见 BUILD-NOTES.md`);
}

main();
