#!/usr/bin/env node
/**
 * P0-10：真 harness 多步验收（todo + 新文件 + 测试 + finish 证据）。
 *
 * 与 `harness-smoke.mjs` 的区别：那个证明"能修一个失败测试"，
 * 这个证明"能按计划做多步活"——要求轨迹里真的出现 `todo_write`，
 * 新文件真的建出来，测试真的跑过，最后 `finish` 真的通过证据校验。
 *
 * 用法：
 *   node scripts/accept/accept-harness-multistep.mjs --yes-spend
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const MODEL = process.env.ACCEPT_MODEL ?? "deepseek-v4.1-flash-1017";
const PROVIDER = process.env.ACCEPT_PROVIDER ?? "";
const MAX_TASK_TOKENS = Number(process.env.ACCEPT_MAX_TOKENS ?? 300_000);
const CLI = path.join(ROOT, "dist-cli", "hosts", "cli", "ding.js");
const LOG = path.join(ROOT, ".verify", "harness-smoke-multistep.log");

if (!process.argv.includes("--yes-spend")) {
  process.stdout.write(
    `计划：用真模型 ${PROVIDER || "(默认通道)"}/${MODEL} 做多步任务（新增 mul + 补测试 + 跑测试 + todo/finish）\n` +
      `  预算：单任务 ≤ ¥2（按 token 闸 ${MAX_TASK_TOKENS} 记账）\n`,
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

const work = mkdtempSync(path.join(tmpdir(), "ding-harness-multi-"));
const dataDir = path.join(work, ".data");
mkdirSync(path.join(work, "src"), { recursive: true });
mkdirSync(path.join(work, "test"), { recursive: true });
mkdirSync(dataDir, { recursive: true });

const write = (rel, text) => writeFileSync(path.join(work, rel), text, "utf8");
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    cwd: opts.cwd ?? work,
    encoding: "utf8",
    env: { ...process.env, DING_DATA_DIR: dataDir, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 15 * 60 * 1000,
  });

write(
  "package.json",
  JSON.stringify({ name: "ding-harness-multi-fixture", private: true, version: "0.0.0", scripts: { test: "node test/mul.test.js" } }, null, 2),
);
write(
  "src/sum.js",
  ["function sum(a, b) {", "  return a + b;", "}", "", "module.exports = { sum };", ""].join("\n"),
);
write(
  "test/sum.test.js",
  ['const assert = require("node:assert");', 'const { sum } = require("../src/sum");', "assert.strictEqual(sum(2, 3), 5);", 'console.log("PASS sum");', ""].join("\n"),
);

const git = (args) => run("git", args);
git(["init", "-q"]);
git(["config", "user.name", "ding-harness-accept"]);
git(["config", "user.email", "accept@ding.invalid"]);
git(["add", "-A"]);
git(["-c", "user.name=ding-harness-accept", "-c", "user.email=accept@ding.invalid", "commit", "-q", "-m", "初始：只有 sum"]);

const declare = run(process.execPath, [
  CLI,
  "models",
  "add",
  MODEL,
  ...(PROVIDER ? ["--provider", PROVIDER] : []),
  "--window",
  "1000000",
]);
if (declare.status !== 0) {
  process.stderr.write(`[harness-multi] 声明模型能力失败（继续跑）：${(declare.stdout ?? "") + (declare.stderr ?? "")}\n`);
}

const startedAt = Date.now();
const res = run(process.execPath, [
  CLI,
  "run",
  [
    "分三步完成：",
    "1) 先用 todo_write 列出步骤；",
    "2) 新增 src/mul.js 导出 mul(a,b)=a*b，并新增 test/mul.test.js 断言 mul(3,4)===12；",
    "3) 运行测试并在 finish 里附上你实际跑过的命令。",
  ].join(" "),
  "--dir",
  work,
  "--model",
  MODEL,
  "--steps",
  "40",
  "--mode",
  "全部允许",
  "--json",
  ...(PROVIDER ? ["--provider", PROVIDER] : []),
]);
const elapsedMs = Date.now() - startedAt;
const stdout = res.stdout ?? "";
const stderr = res.stderr ?? "";
mkdirSync(path.dirname(LOG), { recursive: true });
writeFileSync(
  LOG,
  [
    `# harness-smoke-multistep ${new Date().toISOString()}`,
    `model=${PROVIDER || "(default)"}/${MODEL} elapsedMs=${elapsedMs} exit=${res.status}`,
    "## stdout",
    stdout,
    "## stderr",
    stderr,
  ].join("\n"),
  "utf8",
);

let outcome = null;
try {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start >= 0 && end > start) outcome = JSON.parse(stdout.slice(start, end + 1));
} catch {
  /* 下面按"没有结构化结果"处理 */
}

const failures = [];
if (res.status !== 0) failures.push(`进程退出码 ${res.status}（期望 0）`);
if (!outcome) failures.push("stdout 里没有结构化结果");
const usage = outcome?.usage ?? {};
const tokens = Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0);
if (tokens > MAX_TASK_TOKENS) failures.push(`token ${tokens} 超过单任务上限 ${MAX_TASK_TOKENS}`);

const traces = Array.isArray(outcome?.traces) ? outcome.traces : [];
if (!traces.some((t) => t.name === "todo_write" && t.ok === true)) failures.push("轨迹里没有成功的 todo_write");
if (!traces.some((t) => t.name === "finish" && t.ok === true)) failures.push("轨迹里没有通过校验的 finish");
if (!existsSync(path.join(work, "src/mul.js"))) failures.push("src/mul.js 没有被创建");
if (!existsSync(path.join(work, "test/mul.test.js"))) failures.push("test/mul.test.js 没有被创建");

const finalTest = run("node", ["test/mul.test.js"]);
if (finalTest.status !== 0) failures.push(`新增的测试没有通过（exit ${finalTest.status}）：${(finalTest.stderr ?? "").slice(0, 300)}`);

if (failures.length) {
  process.stderr.write(`✗ harness-smoke-multistep 失败：\n- ${failures.join("\n- ")}\n完整日志：${LOG}\n`);
  process.exit(1);
}

process.stdout.write(
  `✓ harness-smoke-multistep 通过：todo_write / 新文件 / 测试 / finish 都有证据；` +
    `exit=0，wall=${(elapsedMs / 1000).toFixed(1)}s，tokens=${tokens}（价格未核实，未折算金额）\n`,
);
try {
  rmSync(work, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}
