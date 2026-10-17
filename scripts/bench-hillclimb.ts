/**
 * 爬山闭环（V6-1b）。
 *
 * ## 它解决的是什么
 *
 * "改了以后分数涨了没有"这个问题，凭感觉答会骗自己：
 *   · 只跑一遍、只看总分 → 把噪声当提升；
 *   · 只看训练集 → 过拟合到自建任务；
 *   · 每轮改三处 → 涨了不知道为什么涨，跌了不知道退回哪一处。
 *
 * 所以这个脚本只做四件事：
 *   1. **train/test 分开跑**（两边都涨才算数）；
 *   2. **显著性门槛**（两比例 z 检验 + 至少 +0.03 的效应量）；
 *   3. **一轮一条记录**（归档到 `bench/archive/rounds.jsonl`，带 git sha）；
 *   4. **每轮只改一处**（工作树改动文件 > 1 时提醒，`--allow-multi` 才继续）。
 *
 * ## 它不跑真模型
 *
 * 默认跑 `harness` 套（脚本化 provider，确定性、不花钱）。
 * SWE-bench 那类需要真模型的任务**不在这个循环里** —— 那个进独立的
 * budget/workflow（见 `bench/swebench/README.md`），否则"爬山"会先把账单爬上去。
 *
 * 用法：
 *   pnpm bench:hillclimb --label "ICM: 活状态优先" --repeat 2
 *   pnpm bench:hillclimb --label "..." --archive other.jsonl --allow-multi
 *   pnpm bench:hillclimb --label "..." --json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { benchRoot, loadSuite } from "../engine/bench/load";
import { runBenchSuite } from "../engine/bench/run";
import type { BenchReport } from "../engine/bench/types";
import { buildEngine } from "../hosts/cli/assembly";

/** 每轮至少要有这么大的提升（效应量门槛）。 */
const MIN_DELTA = 0.03;
/** 两比例 z 检验的临界值（双侧 5%）。 */
const Z_CRITICAL = 1.96;

type Round = {
  at: string;
  label: string;
  gitSha: string;
  changedFiles: number;
  samples: number;
  train: { passed: number; total: number; rate: number };
  test: { passed: number; total: number; rate: number };
  decision: "baseline" | "keep" | "revert" | "noise";
  reason: string;
};

function arg(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const has = (name: string) => process.argv.includes(`--${name}`);

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", cwd: process.cwd() }).trim();
  } catch {
    return "";
  }
}

/** 工作树改了哪些文件（"每轮只改一处"的尺子）。 */
function changedFiles(): number {
  const out = git(["diff", "--name-only", "HEAD"]);
  return out ? out.split("\n").filter(Boolean).length : 0;
}

/**
 * 两比例 z 检验。
 *
 * @returns z 值；分母为 0（两边都没样本/都没通过）时返回 0
 */
export function twoProportionZ(a: { passed: number; total: number }, b: { passed: number; total: number }): number {
  if (!a.total || !b.total) return 0;
  const p1 = a.passed / a.total;
  const p2 = b.passed / b.total;
  const pooled = (a.passed + b.passed) / (a.total + b.total);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.total + 1 / b.total));
  if (se === 0) return 0;
  return (p1 - p2) / se;
}

/**
 * 裁决：候选 vs 上一轮。
 *
 * @param candidate 这一轮（train/test）
 * @param previous 上一轮
 * @returns 裁决与一句人话
 */
export function decideRound(
  candidate: { train: { passed: number; total: number }; test: { passed: number; total: number } },
  previous: { train: { passed: number; total: number }; test: { passed: number; total: number } },
): { decision: Round["decision"]; reason: string } {
  const dTrain = (candidate.train.passed - previous.train.passed) / Math.max(1, previous.train.total);
  const dTest = (candidate.test.passed - previous.test.passed) / Math.max(1, previous.test.total);
  const zTrain = twoProportionZ(candidate.train, previous.train);
  const zTest = twoProportionZ(candidate.test, previous.test);

  /* 两边都涨、都过显著性门槛、效应量也够 → 才保留 */
  if (dTrain >= MIN_DELTA && dTest >= MIN_DELTA && zTrain >= Z_CRITICAL && zTest >= Z_CRITICAL) {
    return {
      decision: "keep",
      reason: `train +${(dTrain * 100).toFixed(1)}pp（z=${zTrain.toFixed(2)}）、test +${(dTest * 100).toFixed(1)}pp（z=${zTest.toFixed(2)}）`,
    };
  }
  /* 任一边显著下降 → 退回（不看另一边涨了多少） */
  if ((dTrain <= -MIN_DELTA && zTrain <= -Z_CRITICAL) || (dTest <= -MIN_DELTA && zTest <= -Z_CRITICAL)) {
    return {
      decision: "revert",
      reason: `train ${(dTrain * 100).toFixed(1)}pp（z=${zTrain.toFixed(2)}）、test ${(dTest * 100).toFixed(1)}pp（z=${zTest.toFixed(2)}）—— 有一边显著跌了`,
    };
  }
  return {
    decision: "noise",
    reason: `train ${(dTrain * 100).toFixed(1)}pp（z=${zTrain.toFixed(2)}）、test ${(dTest * 100).toFixed(1)}pp（z=${zTest.toFixed(2)}）—— 没到「两边都显著涨」的门槛`,
  };
}

function rateOf(report: BenchReport): { passed: number; total: number; rate: number } {
  return { passed: report.passed, total: report.total, rate: report.rate };
}

async function runSplit(
  root: string,
  split: "train" | "test",
  repeat: number,
): Promise<BenchReport> {
  const loaded = loadSuite("harness", root);
  const tasks = loaded.tasks.filter((t) => t.split === split);
  return runBenchSuite(
    tasks,
    {
      makeEngine: async (workDir) => {
        const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-hill-store-"));
        const built = await buildEngine([workDir], storeDir);
        return {
          engine: built.engine,
          close: () => {
            built.close();
            fs.rmSync(storeDir, { recursive: true, force: true });
          },
        };
      },
    },
    { suite: `harness:${split}`, repeat, root: loaded.file },
  );
}

function readArchive(file: string): Round[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Round;
      } catch {
        return null;
      }
    })
    .filter((r): r is Round => r !== null);
}

async function main(): Promise<void> {
  const label = arg("label");
  if (!label) {
    process.stderr.write("要一个 --label（一句话说清这一轮只改了什么）。\n");
    process.exit(2);
  }
  const repeat = Math.max(1, Math.min(20, Number(arg("repeat", "1")) || 1));
  const archive = path.resolve(arg("archive", path.join("bench", "archive", "rounds.jsonl"))!);
  const json = has("json");
  const root = benchRoot(process.cwd());

  const changed = changedFiles();
  const multi = changed > 1;
  if (multi && !has("allow-multi")) {
    process.stderr.write(
      `⚠️ 工作树改了 ${changed} 个文件。"每轮只改一处"是爬山能归因的前提；\n` +
        `   确认这一轮确实只该有一处改动，或者加 --allow-multi 继续。\n`,
    );
    process.exit(2);
  }

  const train = await runSplit(root, "train", repeat);
  const test = await runSplit(root, "test", repeat);

  const previous = readArchive(archive).at(-1);
  const current = {
    train: { passed: train.passed, total: train.total },
    test: { passed: test.passed, total: test.total },
  };
  const decision = previous ? decideRound(current, previous) : { decision: "baseline" as const, reason: "第一轮（没有可比的上一轮）" };
  const round: Round = {
    at: new Date().toISOString(),
    label,
    gitSha: git(["rev-parse", "--short", "HEAD"]) || "unknown",
    changedFiles: changed,
    samples: repeat,
    train: rateOf(train),
    test: rateOf(test),
    decision: decision.decision,
    reason: decision.reason,
  };

  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.appendFileSync(archive, JSON.stringify(round) + "\n", "utf8");

  if (json) {
    process.stdout.write(JSON.stringify(round, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    `\n第 ${readArchive(archive).length} 轮「${label}」\n` +
      `  train ${round.train.passed}/${round.train.total}（${round.train.rate}%）\n` +
      `  test  ${round.test.passed}/${round.test.total}（${round.test.rate}%）\n` +
      `  裁决：${round.decision} —— ${round.reason}\n` +
      `  归档：${archive}\n`,
  );
  /*
   * 退出码：revert → 1（让调用方/CI 知道这一轮该回退）。
   * keep/noise/baseline → 0（noise 不是"坏"，只是"证据不够"）。
   */
  process.exitCode = round.decision === "revert" ? 1 : 0;
}

void main().catch((error: unknown) => {
  process.stderr.write(`出错了：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
