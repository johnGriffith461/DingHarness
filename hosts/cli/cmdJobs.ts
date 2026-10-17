import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { appendJob, findJob, jobLogPath, listJobs, tailLog, type JobRecord, type JobStatus } from "../../engine/runtime/jobs";
import { enqueueSteer, pendingSteer } from "../../engine/runtime/inbox";
import { flag, type Parsed } from "./args";

/**
 * `ding steer <会话 id> "话"` —— **中途插话**（G06，2026-10-18）。
 *
 * 把话写进会话的插话队列；正在跑的那一轮在**下一步之前**取走它，
 * 作为一条 user 消息插进上下文（不打断正在生成的那一步）。
 */
export function cmdSteer(p: Parsed, dataDir: string): number {
  const sessionId = p.args[0];
  const text = p.args.slice(1).join(" ").trim();
  if (!sessionId || !text) {
    process.stderr.write('用法：ding steer <会话 id> "要补的话"\n');
    return 2;
  }
  if (!enqueueSteer(dataDir, sessionId, text)) {
    process.stderr.write("没写进去（数据目录不可写？）\n");
    return 1;
  }
  const pending = pendingSteer(dataDir, sessionId);
  process.stdout.write(`✓ 已投递（队列里还有 ${pending} 条；下一步会取走）\n`);
  return 0;
}

/**
 * `ding jobs [list|show|wait|cancel]` —— 后台任务（G06）。
 *
 * ## `ding run --background` 做了什么
 *
 * 起一个**脱离的**子进程跑同一份 CLI（同一个入口、同一套参数），
 * stdout/stderr 写进 `<数据目录>/jobs/<id>.log`，并在 `jobs.jsonl` 记开始/结束。
 * 这里不重复实现"跑一轮"的逻辑 —— 它调的是 `ding run` 本身。
 */
export function cmdJobs(p: Parsed, dataDir: string): number {
  const sub = p.args[0] ?? "list";

  if (sub === "list") {
    const jobs = listJobs(dataDir);
    if (p.flags.has("json")) {
      process.stdout.write(`${JSON.stringify(jobs, null, 2)}\n`);
      return 0;
    }
    if (!jobs.length) {
      process.stdout.write("还没有后台任务。用 `ding run \"…\" --background` 起一个。\n");
      return 0;
    }
    for (const job of jobs) {
      process.stdout.write(
        `${job.id.padEnd(20)} ${job.status.padEnd(9)} ${new Date(job.at).toLocaleString("zh-CN")}  ${job.prompt}\n`,
      );
    }
    return 0;
  }

  const id = p.args[1];
  if (sub === "show") {
    if (!id) {
      process.stderr.write("用法：ding jobs show <任务 id>\n");
      return 2;
    }
    const job = findJob(dataDir, id);
    if (!job) {
      process.stderr.write(`没有这个任务：${id}\n`);
      return 1;
    }
    process.stdout.write(`任务：${job.id}\n状态：${job.status}${typeof job.exitCode === "number" ? `（退出码 ${job.exitCode}）` : ""}\n`);
    process.stdout.write(`开始：${new Date(job.at).toLocaleString("zh-CN")}\n`);
    process.stdout.write(`要求：${job.prompt}\n`);
    if (job.sessionId) process.stdout.write(`会话：${job.sessionId}（ding sessions --state ${job.sessionId}）\n`);
    if (job.logPath) {
      process.stdout.write(`日志：${job.logPath}\n\n--- 尾部 ---\n${tailLog(job.logPath, 40) || "（还没有输出）"}\n`);
    }
    return 0;
  }

  if (sub === "wait") {
    if (!id) {
      process.stderr.write("用法：ding jobs wait <任务 id>\n");
      return 2;
    }
    /*
     * 轮询记录文件（不挂到子进程上 —— 它可能不是本进程起的，甚至是上一次开机起的）。
     * 每 500ms 一次，最多等到 `--timeout`（默认 30 分钟）。
     */
    const timeoutSec = Number(flag(p, "timeout") ?? "1800");
    const deadline = Date.now() + (Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 1_800_000);
    for (;;) {
      const job = findJob(dataDir, id);
      if (!job) {
        process.stderr.write(`没有这个任务：${id}\n`);
        return 1;
      }
      if (job.status !== "running") {
        process.stdout.write(`${job.status}${typeof job.exitCode === "number" ? `（退出码 ${job.exitCode}）` : ""}\n`);
        return job.status === "finished" ? 0 : 1;
      }
      if (Date.now() > deadline) {
        process.stderr.write("等超时了（任务还在跑）—— 用 ding jobs show 看进度\n");
        return 1;
      }
      spawnSync(process.execPath, ["-e", "setTimeout(()=>{},500)"], { stdio: "ignore" });
    }
  }

  if (sub === "cancel") {
    if (!id) {
      process.stderr.write("用法：ding jobs cancel <任务 id>\n");
      return 2;
    }
    const job = findJob(dataDir, id);
    if (!job) {
      process.stderr.write(`没有这个任务：${id}\n`);
      return 1;
    }
    /*
     * 如实说清能力边界：后台进程是**脱离的**，父进程手里没有它的句柄。
     * 能做的只是"把记录标成已取消"，以及按端口/命令行找进程 —— 后者不可靠（有同名进程）。
     * 所以这里只标状态，并告诉用户怎么真的停（去找那个进程）。
     */
    if (job.status !== "running") {
      process.stdout.write(`这条任务已经是 ${job.status}，不用取消。\n`);
      return 0;
    }
    appendJob(dataDir, { id: job.id, status: "cancelled", at: Date.now(), prompt: job.prompt });
    process.stdout.write("已把这条任务标记为取消。\n");
    process.stdout.write("注意：后台进程是脱离的，父进程没有它的句柄 —— 真要停那个进程，用任务管理器按命令行找，\n");
    process.stdout.write("或者在任务开始前用 `ding jobs` 记下 pid（本轮还没记 pid，如实说明）。\n");
    return 0;
  }

  process.stderr.write("用法：ding jobs <list|show|wait|cancel> [任务 id]\n");
  return 2;
}

/** 后台运行的元数据（由 `ding run --background` 用）。 */
export type BackgroundPlan = {
  id: string;
  logPath: string;
  sessionId: string;
};

/**
 * 起一个后台 `ding run`。
 *
 * @param input.argv 原始参数（会去掉 `--background`）
 * @param input.prompt 任务描述（记录与显示用）
 * @param input.sessionId 会话 id（父进程先生成，子进程沿用）
 */
export function spawnBackgroundRun(input: {
  dataDir: string;
  argv: readonly string[];
  prompt: string;
  sessionId: string;
}): BackgroundPlan {
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const logPath = jobLogPath(input.dataDir, id);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, "a");

  const args = input.argv.filter((a) => a !== "--background" && a !== "-b");
  /*
   * `process.argv[1]` 是这个 CLI 的入口（tsx 下是 `hosts/cli/ding.ts`，
   * 产物下是 `dist-cli/hosts/cli/ding.js`）—— 两种形态都能再起一个自己。
   */
  const entry = process.argv[1] ?? "";
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, DSH_JOB_ID: id, DSH_JOB_PROMPT: input.prompt, DSH_SESSION_HINT: input.sessionId },
    cwd: process.cwd(),
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);

  const base: JobRecord = {
    id,
    status: "running",
    at: Date.now(),
    sessionId: input.sessionId,
    prompt: input.prompt.slice(0, 200),
    logPath,
  };
  appendJob(input.dataDir, base);

  /* 结束状态由子进程自己写（它知道退出码）；这里挂一个监听只是兜底 */
  child.on("exit", (code) => {
    const status: JobStatus = code === 0 ? "finished" : "failed";
    appendJob(input.dataDir, { ...base, status, at: Date.now(), exitCode: code ?? undefined });
  });
  return { id, logPath, sessionId: input.sessionId };
}

/**
 * 子进程收尾时写自己的结束状态（`DSH_JOB_ID` 存在时）。
 *
 * @param dataDir 数据目录
 * @param exitCode 退出码
 */
export function recordJobExit(dataDir: string, exitCode: number): void {
  const id = process.env.DSH_JOB_ID?.trim();
  if (!id) return;
  appendJob(dataDir, {
    id,
    status: exitCode === 0 ? "finished" : "failed",
    at: Date.now(),
    prompt: process.env.DSH_JOB_PROMPT ?? "",
    exitCode,
  });
}
