import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { jobIdsForTest, killJob, listJobs, readJob, shutdownJobs, startJob } from "./jobs";

/**
 * B-03：后台任务表。
 *
 * 判据：能起、能读、能杀、不存在的 id 给人话、退出时清理。
 * 真起子进程（`node -e`），不假 spawn —— 这条能力最怕"看着能跑、其实没起来"。
 */
const NODE = process.execPath;

async function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("等待超时");
}

describe("B-03 · 后台任务", () => {
  it("起一个任务、轮询输出、结束状态与退出码", async () => {
    const started = await startJob({
      command: `"${NODE}" -e "console.log('done-marker')"`,
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitUntil(() => listJobs().some((j) => j.id === started.id && !j.running));
    const got = readJob(started.id, 50);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.job.exitCode).toBe(0);
      expect(got.job.output).toContain("done-marker");
    }
  });

  it("长任务：running 时能读到部分输出；kill 之后不再是 running", async () => {
    const started = await startJob({
      command: `"${NODE}" -e "console.log('started'); setTimeout(()=>{}, 30000)"`,
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitUntil(() => {
      const job = readJob(started.id);
      return job.ok && job.job.output.includes("started");
    });
    const killed = killJob(started.id);
    expect(killed.ok).toBe(true);
    await waitUntil(() => listJobs().some((j) => j.id === started.id && !j.running), 10000);
  });

  it("不存在的 id：给人话，不是抛异常", () => {
    const got = readJob("job-nope");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("没有这个后台任务");
    expect(killJob("job-nope").ok).toBe(false);
  });

  it("shutdownJobs：把所有还在跑的任务杀掉（退出清理）", async () => {
    const killedPids: number[] = [];
    /* 假 spawn：给一个 pid，永不 close；killImpl 只记账 —— 验的是"清理有没有调" */
    const spawnImpl = (() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { end: () => void };
      };
      child.pid = 999_001;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => undefined };
      setImmediate(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const started = await startJob({
      command: "whatever",
      cwd: process.cwd(),
      spawnImpl,
      killImpl: (pid) => killedPids.push(pid),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const before = jobIdsForTest().length;
    shutdownJobs();
    expect(killedPids).toEqual([999_001]);
    expect(jobIdsForTest().length).toBeLessThan(before);
  });
});
