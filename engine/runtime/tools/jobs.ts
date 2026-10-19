import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { TailBuffer } from "./execTool";

/**
 * B-03：**后台任务表**（模型可用的 `run_command background` + `job_output` / `job_kill`）。
 *
 * ## 它和 `engine/runtime/jobs.ts` 的区别
 *
 * 那一份是 **CLI 的后台运行记录**（`ding run --background` 起一个独立进程，写 jobs.jsonl，
 * 跨进程可查）。这一份是**当前进程内**的后台命令表：模型在一步里起一条长命令，
 * 下一步用 `job_output` 轮询、用 `job_kill` 停 —— 不需要退出这一轮。
 *
 * ## 边界（如实写在这里）
 *
 * - 输出只留**尾部 256 KiB**（与 `run_command` 同一个 `TailBuffer`）：`yes` 那种命令
 *   不会把内存吃光；丢了开头会如实标记 `truncated`；
 * - 给了 `dataDir` 时另落 `<dataDir>/jobs/<id>.log`（完整流）；
 * - **进程退出时全部杀掉**（`process.on("exit")`）—— 不留孤儿；
 * - kill 走进程树（Windows `taskkill /T`，POSIX 杀进程组）：只杀外壳会留下孙进程。
 */

export type JobRecord = {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  running: boolean;
  exitCode: number | null;
  /** 当前保留下来的输出（尾部，最多 256 KiB）。 */
  output: string;
  /** 输出是否被截过（丢了开头）。 */
  truncated: boolean;
  pid?: number;
};

type InternalJob = {
  record: Omit<JobRecord, "output" | "truncated">;
  buffer: TailBuffer;
  kill: () => void;
};

const jobs = new Map<string, InternalJob>();
let sequence = 0;

/** 杀掉一个进程**连同它的子进程**（与 `execTool.killTree` 同一口径）。 */
function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已经没了 */
    }
  }
}

/**
 * 起一个后台任务。
 *
 * @param input.command 命令行（字符串；用 shell 跑，与 `run_command` 同口径）
 * @param input.cwd 工作目录（调用方已校验在授权目录内）
 * @param input.dataDir 可选：日志落盘根目录
 * @param input.spawnImpl / input.killImpl 注入点（单测）
 */
export function startJob(input: {
  command: string;
  cwd: string;
  dataDir?: string;
  spawnImpl?: typeof spawn;
  killImpl?: (pid: number) => void;
}): Promise<{ ok: true; id: string; pid?: number } | { ok: false; error: string }> {
  const id = `job-${Date.now().toString(36)}-${(sequence++).toString(36)}`;
  const buffer = new TailBuffer(256 * 1024);
  const record: InternalJob["record"] = {
    id,
    command: input.command,
    cwd: input.cwd,
    startedAt: Date.now(),
    running: true,
    exitCode: null,
  };
  let log: fs.WriteStream | undefined;
  if (input.dataDir) {
    try {
      const dir = path.join(input.dataDir, "jobs");
      fs.mkdirSync(dir, { recursive: true });
      log = fs.createWriteStream(path.join(dir, `${id}.log`), { flags: "a" });
    } catch {
      /* 日志写不进去不该让任务起不来；内存里那份仍然可用 */
    }
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = (input.spawnImpl ?? spawn)(input.command, {
        cwd: input.cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ ok: false, error: `起不来：${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    record.pid = child.pid ?? undefined;

    const push = (chunk: Buffer) => {
      buffer.push(chunk);
      log?.write(chunk);
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);

    const kill = () => {
      if (record.running && typeof record.pid === "number") (input.killImpl ?? killProcessTree)(record.pid);
    };
    jobs.set(id, { record, buffer, kill });

    let settled = false;
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, id, ...(typeof child.pid === "number" ? { pid: child.pid } : {}) });
    });
    child.once("error", (error) => {
      record.running = false;
      log?.end();
      jobs.delete(id);
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: `起不来：${error.message}` });
      }
    });
    child.on("close", (code) => {
      record.running = false;
      record.exitCode = code;
      log?.end();
    });
  });
}

/** 读一个任务（`tailLines` 省略 = 全部保留的输出）。 */
export function readJob(
  id: string,
  tailLines?: number,
): { ok: true; job: JobRecord } | { ok: false; error: string } {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: `没有这个后台任务：${id}（用 run_command 的 background 参数起一个）` };
  const text = job.buffer.text();
  const output =
    typeof tailLines === "number" && tailLines > 0 ? text.split("\n").slice(-Math.floor(tailLines)).join("\n") : text;
  return {
    ok: true,
    job: { ...job.record, output, truncated: job.buffer.dropped > 0 },
  };
}

/** 杀一个任务（已经结束的算成功 —— 目标状态已经达成）。 */
export function killJob(id: string): { ok: true } | { ok: false; error: string } {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: `没有这个后台任务：${id}` };
  job.kill();
  return { ok: true };
}

/** 全部任务（含已结束的；输出带尾部）。 */
export function listJobs(): JobRecord[] {
  return [...jobs.values()].map((job) => ({
    ...job.record,
    output: job.buffer.text(),
    truncated: job.buffer.dropped > 0,
  }));
}

/** 进程退出时清理：**杀光还在跑的**，并把它们从表里摘掉。 */
export function shutdownJobs(): void {
  for (const [id, job] of jobs) {
    if (!job.record.running) continue;
    job.kill();
    jobs.delete(id);
  }
}

/** 测试/诊断用：当前表里的 id。 */
export function jobIdsForTest(): string[] {
  return [...jobs.keys()];
}

/* 进程退出（正常或异常）都清理 —— 不留孤儿进程。 */
process.once("exit", () => {
  shutdownJobs();
});
