import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { drainSteer, enqueueSteer, pendingSteer, steerFileName } from "./inbox";
import { appendJob, findJob, jobLogPath, listJobs, tailLog, type JobRecord } from "./jobs";

/**
 * 后台任务与插话队列（G06）。
 *
 * 判据：
 * ① 插话**投递即出队**（同一条话不会在下一步再插一次）；
 * ② 同 id 的任务记录**最后一条说了算**（append-only 的收敛规则）；
 * ③ 日志尾部**只读尾**（不把几百 MB 读进内存）。
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-g06-"));
  dirs.push(dir);
  return dir;
}

describe("插话队列（inbox）", () => {
  it("⭐ 投递 → 取走：取一次就空，不会重复插", () => {
    const dir = tempDir();
    expect(enqueueSteer(dir, "cli-1", "别改测试")).toBe(true);
    expect(pendingSteer(dir, "cli-1")).toBe(1);
    expect(drainSteer(dir, "cli-1")).toEqual(["别改测试"]);
    expect(drainSteer(dir, "cli-1")).toEqual([]);
  });

  it("多条按投递顺序取出", () => {
    const dir = tempDir();
    enqueueSteer(dir, "s", "第一句");
    enqueueSteer(dir, "s", "第二句");
    expect(drainSteer(dir, "s")).toEqual(["第一句", "第二句"]);
  });

  it("会话之间不串味（各自的文件名）", () => {
    const dir = tempDir();
    enqueueSteer(dir, "a", "给 A 的");
    expect(drainSteer(dir, "b")).toEqual([]);
    expect(drainSteer(dir, "a")).toEqual(["给 A 的"]);
  });

  it("空话不投递", () => {
    const dir = tempDir();
    expect(enqueueSteer(dir, "s", "   ")).toBe(false);
  });

  it("会话 id 被洗成安全文件名（不会带出路径）", () => {
    expect(steerFileName("../../evil")).not.toContain("..");
    expect(steerFileName("a/b")).not.toContain("/");
  });
});

describe("后台任务记录（jobs）", () => {
  const rec = (id: string, status: JobRecord["status"], at: number): JobRecord => ({
    id,
    status,
    at,
    prompt: "跑测试",
  });

  it("⭐ 同 id 多条：最后一条说了算", () => {
    const dir = tempDir();
    appendJob(dir, rec("job-1", "running", 1));
    appendJob(dir, rec("job-1", "finished", 2));
    const jobs = listJobs(dir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("finished");
  });

  it("按开始时间倒序（最近的在最前）", () => {
    const dir = tempDir();
    appendJob(dir, rec("job-a", "finished", 1));
    appendJob(dir, rec("job-b", "running", 2));
    expect(listJobs(dir).map((j) => j.id)).toEqual(["job-b", "job-a"]);
  });

  it("findJob 支持唯一前缀（用户只记得开头几位）", () => {
    const dir = tempDir();
    appendJob(dir, rec("job-abc-1", "running", 1));
    appendJob(dir, rec("job-xyz-2", "running", 2));
    expect(findJob(dir, "job-abc")?.id).toBe("job-abc-1");
    expect(findJob(dir, "job-")).toBeUndefined();
  });

  it("坏行只跳过它自己", () => {
    const dir = tempDir();
    appendJob(dir, rec("ok", "running", 1));
    fs.appendFileSync(path.join(dir, "jobs.jsonl"), "{不是 json\n", "utf8");
    expect(listJobs(dir).map((j) => j.id)).toEqual(["ok"]);
  });

  it("日志只读尾部（大文件不整个读进内存）", () => {
    const dir = tempDir();
    const file = jobLogPath(dir, "job-x");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n"), "utf8");
    const tail = tailLog(file, 5);
    expect(tail).toContain("line 5000");
    expect(tail).not.toContain("line 1\n");
  });

  it("日志不存在时给空串（不抛）", () => {
    expect(tailLog(path.join(tempDir(), "nope.log"))).toBe("");
  });
});
