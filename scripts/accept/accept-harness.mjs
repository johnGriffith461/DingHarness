#!/usr/bin/env node
/**
 * P0-10：真 harness 端到端验收（陌生仓库里把失败测试修到通过）。
 *
 * ## 它证明什么
 *
 * 一条命令、一个**真的**临时仓库、一个**真的** provider：
 * 模型要自己读文件、改实现、跑测试，最后拿退出码 0 说话。
 * 判据全是可观察后果（文件 diff + 测试进程退出码），不看模型自述。
 *
 * ## 闸
 *
 * - 必须显式 `--yes-spend`（没有它只打印计划并退出 2）；
 * - `DING_NO_REAL_MODEL` / `DSH_NO_REAL_MODEL` 开着时拒跑；
 * - 单任务 token 上限 `MAX_TASK_TOKENS`（价格未知时不假装算钱，按 token 记账）。
 *
 * 用法：
 *   pnpm build && pnpm cli:build
 *   node scripts/accept/harness-smoke.mjs --yes-spend
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const MODEL = process.env.ACCEPT_MODEL ?? "deepseek-v4.1-flash-1017";
const PROVIDER = process.env.ACCEPT_PROVIDER ?? "";
/** 保守 token 闸：价格未知时按 token 管住上限（约合 ¥2 以内）。 */
const MAX_TASK_TOKENS = Number(process.env.ACCEPT_MAX_TOKENS ?? 300_000);
const CLI = path.join(ROOT, "dist-cli", "hosts", "cli", "ding.js");
const LOG = path.join(ROOT, ".verify", "harness-smoke.log");

if (!process.argv.includes("--yes-spend")) {
  process.stdout.write(
    `计划：用真模型 ${PROVIDER || "(默认通道)"}/${MODEL} 在临时仓库里修复一个失败测试\n` +
      `  预算：单任务 ≤ ¥2（按 token 闸 ${MAX_TASK_TOKENS} 记账；价格未知时不假装算钱）\n` +
      `  需要：dist-cli 已构建（pnpm cli:build）、凭据可用、加 --yes-spend\n`,
  );
  process.exit(2);
}
if (process.env.DING_NO_REAL_MODEL?.trim() || process.env.DSH_NO_REAL_MODEL?.trim()) {
  process.stderr.write("零出网闸开着（DING_NO_REAL_MODEL / DSH_NO_REAL_MODEL）：先取消再跑\n");
  process.exit(2);
}
if (!existsSync(CLI)) {
  process.stderr.write(`没有 ${CLI}：先 pnpm cli:build\n`);
  process.exit(2);
}

const work = mkdtempSync(path.join(tmpdir(), "ding-harness-smoke-"));
const dataDir = path.join(work, ".data");
mkdirSync(path.join(work, "src"), { recursive: true });
mkdirSync(path.join(work, "test"), { recursive: true });
mkdirSync(dataDir, { recursive: true });

function write(rel, text) {
  writeFileSync(path.join(work, rel), text, "utf8");
}
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: opts.cwd ?? work,
    encoding: "utf8",
    env: { ...process.env, DING_DATA_DIR: dataDir, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 15 * 60 * 1000,
  });
}

write(
  "package.json",
  JSON.stringify({ name: "ding-harness-smoke-fixture", private: true, version: "0.0.0", scripts: { test: "node test/sum.test.js" } }, null, 2),
);
write(
  "src/sum.js",
  ["/* 故意写错：sum 应该是加法 */", "function sum(a, b) {", "  return a - b;", "}", "", "module.exports = { sum };", ""].join("\n"),
);
write(
  "test/sum.test.js",
  [
    'const assert = require("node:assert");',
    'const { sum } = require("../src/sum");',
    "",
    "assert.strictEqual(sum(1, 2), 3, `sum(1,2) 应当是 3，实际是 ${sum(1, 2)}`);",
    'console.log("PASS sum(1,2)===3");',
    "",
  ].join("\n"),
);

const git = (args) => run("git", args);
git(["init", "-q"]);
git(["config", "user.name", "ding-harness-accept"]);
git(["config", "user.email", "accept@ding.invalid"]);
git(["add", "-A"]);
git(["-c", "user.name=ding-harness-accept", "-c", "user.email=accept@ding.invalid", "commit", "-q", "-m", "初始：一个失败的测试"]);

/* 先声明模型窗口（1M）—— 不声明的话预算按 20k 保守默认，验收会失真 */
const declare = run(process.execPath, [
  CLI,
  "models",
  "add",
  MODEL,
  ...(PROVIDER ? ["--provider", PROVIDER] : []),
  "--window",
  "1000000",
]);
const declareOut = `${declare.stdout ?? ""}${declare.stderr ?? ""}`;
if (declare.status !== 0) {
  process.stderr.write(`[harness-smoke] 声明模型能力失败（继续跑，但预算口径会退到保守默认）：\n${declareOut}\n`);
}

const startedAt = Date.now();
const res = run(process.execPath, [
  CLI,
  "run",
  "这个仓库里有一个失败的测试：sum(1,2) 应该是 3 但现在是错的。修复 sum 函数，并运行测试证实通过。",
  "--dir",
  work,
  "--model",
  MODEL,
  "--steps",
  "30",
  "--mode",
  "全部允许",
  "--json",
  ...(PROVIDER ? ["--provider", PROVIDER] : []),
]);
const elapsedMs = Date.now() - startedAt;
const stdout = res.stdout ?? "";
const stderr = res.stderr ?? "";
const fullLog = [
  `# harness-smoke ${new Date().toISOString()}`,
  `model=${PROVIDER || "(default)"}/${MODEL} elapsedMs=${elapsedMs} exit=${res.status}`,
  `declare=${declareOut.trim()}`,
  "## stdout",
  stdout,
  "## stderr",
  stderr,
].join("\n");
mkdirSync(path.dirname(LOG), { recursive: true });
writeFileSync(LOG, fullLog, "utf8");

let outcome = null;
try {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start >= 0 && end > start) outcome = JSON.parse(stdout.slice(start, end + 1));
} catch {
  /* 解析失败在下面按"没有结构化结果"处理 */
}

const failures = [];
if (res.status !== 0) failures.push(`进程退出码 ${res.status}（期望 0）`);
if (!outcome) failures.push("stdout 里没有结构化结果（--json 没生效？）");
const usage = outcome?.usage ?? {};
const tokens = Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0);
if (tokens > MAX_TASK_TOKENS) failures.push(`token ${tokens} 超过单任务上限 ${MAX_TASK_TOKENS}`);

const changed = git(["diff", "--name-only"]).stdout?.split(/\r?\n/).filter(Boolean) ?? [];
if (!changed.includes("src/sum.js")) failures.push(`src/sum.js 没有被改动（改动：${changed.join(", ") || "无"}）`);
if (changed.includes("test/sum.test.js")) failures.push("test/sum.test.js 被改动了（修缺陷不许改测试）");
if (changed.length === 0) failures.push("git diff 为空：模型什么都没改");

const traces = Array.isArray(outcome?.traces) ? outcome.traces : [];
const ranTest = traces.some(
  (t) => t.name === "run_command" && t.ok === true && /node\s+test\/sum\.test\.js|npm\s+test|pnpm\s+test/.test(t.line ?? ""),
);
if (!ranTest) failures.push("工具轨迹里没有一次成功的测试命令");
const finalTest = run("node", ["test/sum.test.js"]);
if (finalTest.status !== 0) failures.push(`修复后的测试仍然失败（exit ${finalTest.status}）：${(finalTest.stderr ?? "").slice(0, 300)}`);

if (failures.length) {
  process.stderr.write(`✗ harness-smoke 失败：\n- ${failures.join("\n- ")}\n完整日志：${LOG}\n`);
  process.exit(1);
}

process.stdout.write(
  `✓ harness-smoke 通过：${changed.join(", ")} 被改，测试通过；` +
    `exit=0，wall=${(elapsedMs / 1000).toFixed(1)}s，tokens=${tokens}（价格未核实，未折算金额）\n`,
);
/* 成功也保留日志（证据），但清理临时仓库 */
try {
  rmSync(work, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}
