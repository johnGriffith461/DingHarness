import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Engine } from "../index";
import type { TurnEvent } from "../runtime/loop";
import { summarizeFailures, type FailureKind } from "../eval/failClassifier";
import { startFakeProvider, type EvalReply } from "../eval/fakeProvider";
import { copySeed, dockerAvailable, gradeTask, type BenchFailure } from "./grade";
import { envLockProblem } from "./load";
import type { BenchReport, BenchTask, BenchTaskResult } from "./types";

/**
 * 基准执行器（V6-1a）。
 *
 * 与 `engine/eval/run.ts` 的分工：
 *   · `eval` 判**过程**（事件序列、回显文案、闸门）—— 内部夹具，防回归；
 *   · `bench` 判**任务结果**（文件内容 + 判分命令）—— 公开成绩，回答"能不能干活"。
 *
 * 两者共用假 provider 与同一条引擎装配路，但**报告分开**：把过程用例的
 * 通过率混进基准成绩，等于拿"自己出的题"当"能干活"的证据。
 */

/** 宿主提供的装配（CLI 给真装配，测试给同一份）。 */
export type BenchDeps = {
  /** 为这个工作目录建引擎。 */
  makeEngine: (workDir: string) => Promise<{ engine: Engine; close: () => void }>;
  /** 真 provider 的 provider/model（脚本化任务不需要）。 */
  provider?: string;
  model?: string;
  /** 判分命令是否套容器（任务声明了 `environment.docker` 才生效）。 */
  docker?: boolean;
  /** 单任务看门狗（毫秒，默认 5 分钟）。 */
  watchdogMs?: number;
};

function tempDir(taskId: string): string {
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return fs.mkdtempSync(path.join(os.tmpdir(), `dh-bench-${safe}-`));
}

/** 把 `{{dir}}` 换成本次工作目录（任务集是静态数据，目录是运行时才有的）。 */
function substituteReplies(replies: readonly EvalReply[][], workDir: string): EvalReply[][] {
  const escaped = JSON.stringify(workDir).slice(1, -1);
  const walk = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll("{{dir}}", escaped));
  return replies.map((turn) => turn.map((reply) => walk(reply) as EvalReply));
}

/** 一次采样的结果。 */
type OneRun = {
  ok: boolean;
  failures: BenchFailure[];
  eventTypes: string[];
  usage: { input: number; output: number };
  ms: number;
  /** 环境问题（不是产品失败）。 */
  skipped?: string;
};

/**
 * 跑一条任务一次。
 *
 * @param task 任务
 * @param deps 装配
 * @param sample 第几次采样（只用于 parentMark 与日志，不影响判分）
 */
async function runOnce(task: BenchTask, deps: BenchDeps, sample: number): Promise<OneRun> {
  const started = Date.now();
  const workDir = tempDir(task.id);
  const parentMark = `[bench-parent:${task.id}:${sample}]`;
  const events: TurnEvent[] = [];
  const failures: BenchFailure[] = [];
  let provider: Awaited<ReturnType<typeof startFakeProvider>> | null = null;
  let close: (() => void) | null = null;
  const prevBase = process.env.STRATA_BASE_URL;
  const prevKey = process.env.STRATA_API_KEY;

  try {
    copySeed(task.seed ? path.resolve(task.dir, task.seed) : undefined, workDir);

    const useFake = task.source?.kind !== "swebench";
    if (useFake) {
      if (!task.replies?.length) {
        return { ok: false, failures: [{ kind: "exception", what: "任务定义", detail: "脚本化任务缺 replies" }], eventTypes: [], usage: { input: 0, output: 0 }, ms: Date.now() - started };
      }
      const replies = substituteReplies(task.replies, workDir);
      provider = await startFakeProvider(replies.flat(), task.turns, { parentMark });
      process.env.STRATA_BASE_URL = provider.url;
      process.env.STRATA_API_KEY = "bench-key";
    }

    const built = await deps.makeEngine(workDir);
    close = built.close;
    const watchdog = new AbortController();
    const timer = setTimeout(() => watchdog.abort(), deps.watchdogMs ?? 300_000);
    try {
      for (const turn of task.turns) {
        await built.engine.run({
          sessionId: `bench-${task.id}-${sample}`,
          provider: useFake ? "strata" : (deps.provider ?? "deepseek"),
          model: useFake ? "deepseek-flash" : (deps.model ?? "deepseek-chat"),
          system: useFake ? parentMark : "",
          abortSignal: watchdog.signal,
          messages: [{ role: "user", content: turn }],
          mode: task.mode ?? "全部允许",
          useTools: task.useTools !== false,
          maxSteps: task.maxSteps ?? 12,
          onEvent: (e) => events.push(e),
        });
      }
    } finally {
      clearTimeout(timer);
    }

    failures.push(...gradeTask(task, workDir, {
      docker: deps.docker && task.environment?.docker ? { image: task.environment.docker.image } : undefined,
    }));
  } catch (error) {
    failures.push({ kind: "exception", what: "执行异常", detail: String((error as Error)?.message ?? error).split("\n")[0]?.slice(0, 200) ?? "未知异常" });
  } finally {
    try {
      close?.();
    } catch {
      /* 收尾失败不影响判定 */
    }
    if (provider) await provider.close();
    if (prevBase === undefined) delete process.env.STRATA_BASE_URL;
    else process.env.STRATA_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.STRATA_API_KEY;
    else process.env.STRATA_API_KEY = prevKey;
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const usage = events.reduce(
    (acc, e) => {
      if (e.type !== "done" || !e.usage) return acc;
      acc.input += e.usage.inputTokens ?? 0;
      acc.output += e.usage.outputTokens ?? 0;
      return acc;
    },
    { input: 0, output: 0 },
  );

  /*
   * 判分命令起不来（PATH 里没有 node、Docker 拉不到镜像）→ 环境问题。
   * 只有 `spawnError` 这一种进这个分支；命令自己退出码不对仍是产品失败。
   */
  const spawnProblems = failures.filter((f) => f.kind === "bench_command" && f.detail.includes("起不来"));
  if (spawnProblems.length === failures.length && spawnProblems.length > 0) {
    return {
      ok: false,
      failures: [],
      eventTypes: events.map((e) => e.type),
      usage,
      ms: Date.now() - started,
      skipped: `判分环境不可用：${spawnProblems[0]!.detail}`,
    };
  }

  return {
    ok: failures.length === 0,
    failures,
    eventTypes: events.map((e) => e.type),
    usage,
    ms: Date.now() - started,
  };
}

/** 按类别/失败类别汇总。 */
function summarize(results: readonly BenchTaskResult[]): {
  byCategory: Record<string, { total: number; passed: number }>;
  byFailure: Partial<Record<FailureKind, number>>;
  allFailures: { kind: FailureKind }[];
} {
  const byCategory: Record<string, { total: number; passed: number }> = {};
  const allFailures: { kind: FailureKind }[] = [];
  for (const r of results) {
    if (r.skipped) continue;
    const slot = (byCategory[r.category] ??= { total: 0, passed: 0 });
    slot.total += 1;
    if (r.ok) slot.passed += 1;
    allFailures.push(...r.failures);
  }
  return { byCategory, byFailure: summarizeFailures(allFailures), allFailures };
}

/**
 * 跑一批任务。
 *
 * @param tasks 任务（必须来自 `loadSuite`，带着任务目录）
 * @param deps 装配
 * @param opts 采样次数与 suite 名
 * @param onProgress 每条跑完回调
 */
export async function runBenchSuite(
  tasks: readonly BenchTask[],
  deps: BenchDeps,
  opts: { suite?: string; repeat?: number; root?: string } = {},
  onProgress?: (r: BenchTaskResult, index: number, total: number) => void,
): Promise<BenchReport> {
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
  const dockerOk = dockerAvailable();
  const results: BenchTaskResult[] = [];

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i]!;
    const skip = envLockProblem(task.environment, { docker: deps.docker ? dockerOk : undefined });
    if (skip) {
      const skipped: BenchTaskResult = {
        id: task.id,
        title: task.title,
        category: task.category,
        split: task.split,
        ok: false,
        runs: 0,
        passedRuns: 0,
        passAtK: false,
        flaky: false,
        ms: 0,
        usage: { input: 0, output: 0 },
        failures: [],
        skipped: skip,
      };
      results.push(skipped);
      onProgress?.(skipped, i + 1, tasks.length);
      continue;
    }

    const runs: OneRun[] = [];
    for (let k = 0; k < repeat; k += 1) runs.push(await runOnce(task, deps, k));
    const real = runs.filter((r) => !r.skipped);
    const skipped = runs.find((r) => r.skipped)?.skipped;
    if (!real.length) {
      const onlySkipped: BenchTaskResult = {
        id: task.id,
        title: task.title,
        category: task.category,
        split: task.split,
        ok: false,
        runs: 0,
        passedRuns: 0,
        passAtK: false,
        flaky: false,
        ms: runs.reduce((s, r) => s + r.ms, 0),
        usage: { input: 0, output: 0 },
        failures: [],
        skipped: skipped ?? "全部采样都被环境问题跳过",
      };
      results.push(onlySkipped);
      onProgress?.(onlySkipped, i + 1, tasks.length);
      continue;
    }

    const ok = real.every((r) => r.ok);
    const passedRuns = real.filter((r) => r.ok).length;
    const merged: BenchTaskResult = {
      id: task.id,
      title: task.title,
      category: task.category,
      split: task.split,
      ok,
      runs: real.length,
      passedRuns,
      passAtK: passedRuns > 0,
      flaky: passedRuns > 0 && passedRuns < real.length,
      ms: runs.reduce((s, r) => s + r.ms, 0),
      usage: {
        input: runs.reduce((s, r) => s + r.usage.input, 0),
        output: runs.reduce((s, r) => s + r.usage.output, 0),
      },
      failures: real.filter((r) => !r.ok).flatMap((r) => r.failures),
      /* 部分采样被环境跳过：如实记下来（别让"跑了一半"看起来像"跑完了"） */
      ...(skipped ? { skipped: `部分采样被跳过：${skipped}` } : {}),
      eventTypes: real[real.length - 1]?.eventTypes ?? [],
    };
    results.push(merged);
    onProgress?.(merged, i + 1, tasks.length);
  }

  const { byCategory, byFailure } = summarize(results);
  const scored = results.filter((r) => !r.skipped);
  const passed = scored.filter((r) => r.ok).length;
  const passAtK = scored.filter((r) => r.passAtK).length;
  const rate = scored.length ? Math.round((passed / scored.length) * 1000) / 10 : 0;
  return {
    suite: opts.suite ?? "harness",
    generatedAt: new Date().toISOString(),
    samples: repeat,
    total: scored.length,
    passed,
    failed: scored.length - passed,
    skipped: results.length - scored.length,
    rate,
    passAtKRate: scored.length ? Math.round((passAtK / scored.length) * 1000) / 10 : 0,
    passAllRate: rate,
    flaky: scored.filter((r) => r.flaky).length,
    byCategory,
    byFailure,
    environment: {
      node: process.versions.node,
      platform: process.platform,
      docker: dockerOk,
      suitePath: opts.root ?? "",
    },
    results,
    usageNote:
      "脚本化任务的用量来自假 provider（按请求体估算），不是账单；真 provider 任务的用量来自上游上报。",
  };
}
