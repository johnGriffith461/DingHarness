#!/usr/bin/env node
/**
 * **nightly → stable 晋升**（E02）：核对证据 → 改版本号。
 *
 * ```bash
 * node scripts/promote-nightly.mjs --manifest .verify/nightly-evidence.json          # 只检查（默认）
 * node scripts/promote-nightly.mjs --manifest … --write                              # 真的改版本号
 * node scripts/promote-nightly.mjs --manifest … --root /tmp/copy --write             # 在副本上演示
 * ```
 *
 * ## 它**不做什么**
 *
 * 不 commit、不打 tag、不发布。原因不是省事：这三件事都是对外/不可逆，
 * 与 `RELEASE.md` 第五条"发布要主人授权"一致。脚本只把**版本号改成可发布形态**，
 * 并把"证据来自哪个提交"再核一遍。
 *
 * ## 判据在 `shared/release.ts`
 *
 * 七道门、版本形状、提交一致、产物摘要 —— 全部引那一份（有单测），
 * 这里只做 IO 与文件改写，不另写一套"什么算全绿"。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/*
 * 判据模块是 TS：Node 22.6+ 的类型剥离（Node 24 默认开）能直接 import .ts。
 * 不用 tsx：发布脚本越少依赖越好，而这里只需要读一份纯函数模块。
 */
const { checkPromotion } = await import(pathToFileURL(path.join(ROOT, "shared", "release.ts")).href);

const manifestPath = flag("manifest", path.join(".verify", "nightly-evidence.json"));
const root = path.resolve(flag("root", ROOT));
const write = argv.includes("--write");
const allowShaMismatch = argv.includes("--allow-sha-mismatch");

function headSha(dir) {
  const got = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  return got.status === 0 ? got.stdout.trim() : "";
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const full = path.isAbsolute(manifestPath) ? manifestPath : path.join(ROOT, manifestPath);
let evidence;
try {
  evidence = readJson(full);
} catch (error) {
  console.error(`读不到 nightly 证据：${full}（${String(error.message ?? error).slice(0, 120)}）`);
  process.exit(1);
}

const sha = headSha(root);
const verdict = checkPromotion(evidence, allowShaMismatch ? {} : sha ? { headSha: sha } : {});
if (!verdict.ok) {
  console.error("✗ 不能晋升：");
  for (const problem of verdict.problems) console.error(`  · ${problem}`);
  console.error("\n（先在同一提交上跑 node scripts/nightly-gates.mjs；证据必须七道门全绿）");
  process.exit(1);
}

const versionFiles = [
  ["shared/version.json", (v) => ({ version: v })],
  ["package.json", (v, obj) => ({ ...obj, version: v })],
  ["packages/cli/package.json", (v, obj) => ({ ...obj, version: v })],
];

console.log(`晋升：${verdict.from} → ${verdict.to}（提交 ${String(evidence.gitSha).slice(0, 12)}）`);
const changes = [];
for (const [rel, patch] of versionFiles) {
  const file = path.join(root, rel);
  let obj;
  try {
    obj = readJson(file);
  } catch {
    continue; /* 这个仓库形态没有那个文件（例如独立仓） */
  }
  if (obj.version === verdict.to) {
    changes.push(`${rel}: 已经是 ${verdict.to}`);
    continue;
  }
  changes.push(`${rel}: ${obj.version} → ${verdict.to}`);
  if (write) writeJson(file, patch(verdict.to, obj));
}
for (const line of changes) console.log(`  · ${line}`);

if (!write) {
  console.log("\n（这是检查模式，什么都没改。确认无误后加 --write；不会 commit、不会发布。）");
} else {
  console.log("\n✓ 版本号已改成 stable 形态。接下来（需主人授权）：");
  console.log("  1) CHANGELOG.md 把「未发布」改成版本号 + 日期");
  console.log("  2) 打 tag 并发布（RELEASE.md 第五条）");
}
