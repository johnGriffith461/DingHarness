#!/usr/bin/env node
/**
 * **nightly 门禁跑一遍，留下晋升证据**（E02）。
 *
 * 它只做两件事：按 RELEASE.md 第六条跑那七道门，把每道门的结论写进
 * `nightly-evidence.json`。**不发布、不打 tag、不改版本号** ——
 * 发布与晋升是另外两步（且发布要主人授权）。
 *
 * ```bash
 * node scripts/nightly-gates.mjs                  # 版本默认把当前 patch +1
 * node scripts/nightly-gates.mjs --base 0.6.0     # 指定基础版本
 * node scripts/nightly-gates.mjs --out .verify/nightly-evidence.json
 * ```
 *
 * 版本形状：`X.Y.Z-nightly.YYYYMMDD`（与 RELEASE.md 第六条一致）。
 *
 * ⚠️ 本脚本要在**同一份提交**上跑完晋升；证据里带 `gitSha`，晋升脚本会核对。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const GATES = [
  "pnpm typecheck",
  "pnpm lint",
  "pnpm test",
  "pnpm eval",
  "pnpm bench",
  "pnpm verify:supply-chain",
  "pnpm verify:sdk",
];

/** 当前版本 → 下一个小版本（nightly 的 base）。 */
function defaultBase() {
  const current = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(current));
  if (!m) throw new Error(`读不出当前版本：${current}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function gitSha() {
  const got = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return got.status === 0 ? got.stdout.trim() : "";
}

/** Windows 上 pnpm 是 .cmd：走 cmd.exe；命令字符串是我们自己写的字面量（没有外部输入）。 */
function run(command, timeoutMs = 900_000) {
  const [file, args] =
    process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", command]]
      : [command.split(" ")[0], command.split(" ").slice(1)];
  const started = Date.now();
  const got = spawnSync(file, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, DSH_NO_REAL_MODEL: process.env.DSH_NO_REAL_MODEL ?? "1", CI: "true" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${got.stdout ?? ""}${got.stderr ?? ""}`;
  return {
    ok: got.status === 0 && !got.error,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    note: got.error ? String(got.error.message ?? got.error).slice(0, 300) : out.trim().slice(-1200),
  };
}

/** 产物摘要（存在才算；没有产物不编一条）。 */
function artifactDigests() {
  const candidates = [
    ["dist-cli/hosts/cli/ding.js", "dist-cli"],
    ["dist/index.html", "dist"],
  ];
  const out = [];
  for (const [rel, label] of candidates) {
    const full = path.join(ROOT, rel);
    if (!existsSync(full)) continue;
    out.push({ name: label, sha256: createHash("sha256").update(readFileSync(full)).digest("hex") });
  }
  return out;
}

const base = flag("base", defaultBase());
const date = new Date();
const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
const version = `${base}-nightly.${ymd}`;
const out = flag("out", path.join(".verify", "nightly-evidence.json"));

console.log(`nightly ${version}（提交 ${gitSha().slice(0, 12)}）`);
const gates = {};
let failed = 0;
for (const gate of GATES) {
  process.stdout.write(`  · ${gate} … `);
  const got = run(gate);
  gates[gate] = { ok: got.ok, at: got.at, elapsedMs: got.elapsedMs, note: got.note };
  console.log(got.ok ? `绿（${Math.round(got.elapsedMs / 1000)}s）` : `红（${Math.round(got.elapsedMs / 1000)}s）`);
  if (!got.ok) failed += 1;
}

const evidence = {
  version,
  gitSha: gitSha(),
  builtAt: new Date().toISOString(),
  gates,
  artifacts: artifactDigests(),
};
const target = path.isAbsolute(out) ? out : path.join(ROOT, out);
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

console.log(`\n证据写到 ${path.relative(ROOT, target)}（${failed} 道门红）`);
if (failed) {
  console.error("✗ 门没全绿：不能晋升。逐条原因见证据里的 note。");
  process.exitCode = 1;
} else {
  console.log("✓ 七道门全绿。下一步：node scripts/promote-nightly.mjs --manifest <证据> [--write]");
}