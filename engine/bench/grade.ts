import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type { FailureKind } from "../eval/failClassifier";
import type { BenchCommandExpect, BenchTask } from "./types";

/**
 * 判分器（V6-1a）。
 *
 * ## 判分只用"外部可观察"的东西
 *
 * 文件内容 + 命令退出码/输出。**不看**模型说了什么、不看事件流里"它声称做过" ——
 * 那些是过程证据（`engine/eval` 管），基准要回答的是"任务到底完成没有"。
 * 两条分开，才不会被"嘴上说完成"刷绿。
 *
 * ## 行尾归一
 *
 * 文本比较前把 CRLF 归成 LF：同一个任务在 Windows/Linux 上必须判得一样。
 * 这不是放宽 —— 文件内容里真正的差异（少一行、改错函数）照样判红。
 */

/** 判分失败（与评测共用 `FailureKind` 封闭表）。 */
export type BenchFailure = { kind: FailureKind; what: string; detail: string };

/** 递归拷贝种子目录（目标是**新建的临时目录**，不覆盖既有内容）。 */
export function copySeed(seedDir: string | undefined, workDir: string): void {
  if (!seedDir) return;
  const walk = (from: string, to: string) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        walk(src, dst);
      } else if (entry.isFile()) {
        fs.copyFileSync(src, dst);
      }
    }
  };
  walk(seedDir, workDir);
}

/** 行尾归一（只影响比较，不改盘上的文件）。 */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** 一条命令的执行结果。 */
export type CommandOutcome = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 起不来/超时的原文（与"命令自己失败"分开）。 */
  spawnError?: string;
  timedOut?: boolean;
};

/** 本机有没有 Docker（`--docker` 的门）。 */
export function dockerAvailable(): boolean {
  try {
    const r = spawnSync("docker", ["--version"], { timeout: 5000, encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 跑一条判分命令。
 *
 * @param argv 命令与参数（不走 shell）
 * @param cwd 工作目录
 * @param timeoutMs 超时
 * @param docker 给了镜像就套容器（工作目录挂到 `/work`）
 * @returns 结果（**不抛**）
 */
export function runGradingCommand(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  docker?: { image: string },
): CommandOutcome {
  const cmd = docker ? "docker" : argv[0]!;
  const args = docker
    ? [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${cwd.replace(/\\/g, "/")}:/work`,
        "-w",
        "/work",
        docker.image,
        ...argv,
      ]
    : argv.slice(1);
  const r = spawnSync(cmd, args, {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    // 不走 shell：`;` / `&&` 在两种平台上的语义不同，任务集不该依赖这种差异
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const timedOut = Boolean(r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT");
  return {
    code: r.status,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
    spawnError: r.error ? r.error.message : undefined,
    timedOut,
  };
}

/**
 * 判一条任务。
 *
 * @param task 任务
 * @param workDir 跑完的工作目录
 * @param opts docker 镜像（可选）
 * @returns 失败项（空 = 通过）
 */
export function gradeTask(
  task: BenchTask,
  workDir: string,
  opts: { docker?: { image: string } } = {},
): BenchFailure[] {
  const failures: BenchFailure[] = [];

  for (const expect of task.grader.files ?? []) {
    const full = path.join(workDir, expect.path);
    const exists = fs.existsSync(full);
    if (expect.mustExist === false) {
      if (exists) failures.push({ kind: "bench_file", what: "判分文件", detail: `不该存在的「${expect.path}」落盘了（闸门没拦住）` });
      continue;
    }
    if (!exists) {
      failures.push({ kind: "bench_file", what: "判分文件", detail: `该存在的「${expect.path}」不存在` });
      continue;
    }
    let text: string;
    try {
      text = normalizeEol(fs.readFileSync(full, "utf8"));
    } catch (error) {
      failures.push({ kind: "bench_file", what: "判分文件", detail: `读不出「${expect.path}」：${String(error).slice(0, 120)}` });
      continue;
    }
    if (expect.equals !== undefined && text !== normalizeEol(expect.equals)) {
      failures.push({ kind: "bench_file", what: "判分文件", detail: `「${expect.path}」内容与期望不一致` });
    }
    for (const needle of expect.contains ?? []) {
      if (!text.includes(normalizeEol(needle))) {
        failures.push({ kind: "bench_file", what: "判分文件", detail: `「${expect.path}」里没有「${needle.slice(0, 80)}」` });
      }
    }
    for (const banned of expect.absent ?? []) {
      if (text.includes(normalizeEol(banned))) {
        failures.push({ kind: "bench_file", what: "判分文件", detail: `「${expect.path}」里不该有「${banned.slice(0, 80)}」` });
      }
    }
  }

  for (const cmd of task.grader.commands ?? []) {
    failures.push(...checkCommand(cmd, workDir, opts.docker));
  }
  return failures;
}

/** 单条命令判分的失败项。 */
function checkCommand(cmd: BenchCommandExpect, workDir: string, docker?: { image: string }): BenchFailure[] {
  const failures: BenchFailure[] = [];
  const timeout = cmd.timeoutMs ?? 30_000;
  const out = runGradingCommand(cmd.argv, workDir, timeout, docker);
  const label = cmd.argv.join(" ");
  if (out.spawnError && !out.timedOut) {
    /*
     * 起不来（例如 PATH 里没有 node）**不是产品失败** —— 但这里先记成判分失败，
     * 由 runner 依据 `spawnError` 改判成"环境跳过"。判分器只管事实。
     */
    failures.push({ kind: "bench_command", what: "判分命令", detail: `起不来：${label}（${out.spawnError.slice(0, 120)}）` });
    return failures;
  }
  if (out.timedOut) {
    failures.push({ kind: "bench_command", what: "判分命令", detail: `超时 ${timeout}ms：${label}` });
    return failures;
  }
  const want = cmd.exitCode ?? 0;
  if (out.code !== want) {
    failures.push({
      kind: "bench_command",
      what: "判分命令",
      detail: `「${label}」退出码 ${out.code ?? "null"}（期望 ${want}）${tail(out)}`,
    });
  }
  for (const needle of cmd.stdoutContains ?? []) {
    if (!out.stdout.includes(needle)) failures.push({ kind: "bench_command", what: "判分命令", detail: `「${label}」stdout 里没有「${needle}」${tail(out)}` });
  }
  for (const needle of cmd.stderrContains ?? []) {
    if (!out.stderr.includes(needle)) failures.push({ kind: "bench_command", what: "判分命令", detail: `「${label}」stderr 里没有「${needle}」${tail(out)}` });
  }
  return failures;
}

/** 失败明细里附一段输出（截断；没输出就不附）。 */
function tail(out: CommandOutcome): string {
  const text = `${out.stdout}${out.stderr}`.trim();
  return text ? `\n输出：${text.slice(-500)}` : "";
}
