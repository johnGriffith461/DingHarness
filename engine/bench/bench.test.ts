import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildEngine } from "../../hosts/cli/assembly";
import { copySeed, gradeTask } from "./grade";
import { runBenchSuite } from "./run";
import type { BenchTask } from "./types";

/**
 * 判分器与执行器（V6-1a）。
 *
 * 判分器测的是"外部可观察的结果"：文件内容与命令退出码。
 * 执行器测的是"任务真的走完了产品那条路"（真引擎、真工具、真闸门）。
 */

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe("判分器", () => {
  it("种子被原样拷进工作目录（含子目录）", () => {
    const seed = tmp("dh-bench-seed-");
    fs.mkdirSync(path.join(seed, "sub"), { recursive: true });
    fs.writeFileSync(path.join(seed, "a.txt"), "A", "utf8");
    fs.writeFileSync(path.join(seed, "sub", "b.txt"), "B", "utf8");
    const work = tmp("dh-bench-work-");
    copySeed(seed, work);
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8")).toBe("A");
    expect(fs.readFileSync(path.join(work, "sub", "b.txt"), "utf8")).toBe("B");
  });

  it("文件判分：contains / absent / mustExist=false 都对得上才通过", () => {
    const work = tmp("dh-bench-grade-");
    fs.writeFileSync(path.join(work, "a.txt"), "hello 42\n", "utf8");
    const task = {
      id: "t",
      dir: work,
      title: "t",
      category: "docs",
      split: "train",
      turns: ["x"],
      grader: {
        files: [
          { path: "a.txt", contains: ["42"] },
          { path: "b.txt", mustExist: false },
        ],
      },
    } satisfies BenchTask;
    expect(gradeTask(task, work)).toEqual([]);

    const bad = {
      ...task,
      grader: { files: [{ path: "a.txt", contains: ["43"] }, { path: "a.txt", absent: ["hello"] }, { path: "c.txt" }] },
    } satisfies BenchTask;
    expect(gradeTask(bad, work)).toHaveLength(3);
  });

  it("命令判分：退出码与 stdout 都看", () => {
    const work = tmp("dh-bench-cmd-");
    const task = (code: number) =>
      ({
        id: "t",
        dir: work,
        title: "t",
        category: "docs",
        split: "train",
        turns: ["x"],
        grader: {
          commands: [{ argv: [process.execPath, "-e", `console.log("ok"); process.exit(${code})`], exitCode: 0, stdoutContains: ["ok"] }],
        },
      }) satisfies BenchTask;
    expect(gradeTask(task(0), work)).toEqual([]);
    const failures = gradeTask(task(3), work);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.detail).toContain("退出码 3");
  });
});

describe("执行器", () => {
  it("一条任务真跑：脚本化 provider → 真工具写盘 → 判分通过", async () => {
    const work = tmp("dh-bench-run-");
    const task: BenchTask = {
      id: "writes-file",
      dir: work,
      title: "写一个文件",
      category: "docs",
      split: "train",
      turns: ["把 r.txt 写成 42"],
      replies: [
        [
          { call: [{ name: "write_file", args: { path: "{{dir}}/r.txt", content: "42\n" } }] },
          { say: "写好了。" },
        ],
      ],
      mode: "全部允许",
      maxSteps: 4,
      grader: { files: [{ path: "r.txt", contains: ["42"] }] },
    };

    const storeDirs: string[] = [];
    const report = await runBenchSuite(
      [task],
      {
        makeEngine: async (workDir) => {
          const storeDir = tmp("dh-bench-store-");
          storeDirs.push(storeDir);
          const built = await buildEngine([workDir], storeDir);
          return { engine: built.engine, close: () => built.close() };
        },
      },
      { suite: "test", repeat: 1 },
    );

    expect(report.total).toBe(1);
    expect(report.passed, report.results.flatMap((r) => r.failures.map((f) => f.detail)).join(" | ")).toBe(1);
    expect(report.byFailure).toEqual({});
    expect(report.results[0]?.eventTypes).toContain("tool-result");

    for (const dir of storeDirs) fs.rmSync(dir, { recursive: true, force: true });
    /*
     * ⚠️ 2026-10-18（CI 在 windows-latest 上红）：这条**真启引擎、真建 SQLite、真跑工具**，
     * 慢一点的 runner 上会超过 vitest 默认的 5 秒 —— 不是产品坏了，是预算没给。
     * 30 秒：够慢机器跑完，真挂住时也能及时失败。
     */
  }, 30_000);
});
