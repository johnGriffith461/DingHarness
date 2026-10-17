import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { benchRoot, envLockProblem, loadSuite, nodeSatisfies, normalizeTask } from "./load";

/**
 * 任务集加载（V6-1a）。
 *
 * 这里守的是**公开集本身**：任务 JSON 写错一个字段，基准就变成"跑不起来"，
 * 而那种错在 CI 里只会表现成一条看不懂的异常。加载器负责把它变成一句能改的话。
 */

describe("版本与环境锁", () => {
  it("Node 版本：主/次/补丁逐级比较", () => {
    expect(nodeSatisfies(">=20", "24.18.0")).toBe(true);
    expect(nodeSatisfies("20", "20.0.0")).toBe(true);
    expect(nodeSatisfies(">=20.11.0", "20.11.0")).toBe(true);
    expect(nodeSatisfies(">=20.11.0", "20.10.9")).toBe(false);
    expect(nodeSatisfies(">=22", "20.0.0")).toBe(false);
    expect(nodeSatisfies(undefined, "18.0.0")).toBe(true);
  });

  it("平台不符 → 跳过原因（不是失败）", () => {
    expect(envLockProblem({ platforms: ["linux"] }, { platform: "win32" })).toContain("需要平台");
    expect(envLockProblem({ platforms: ["win32"] }, { platform: "win32" })).toBeNull();
  });

  it("要 Docker 而本机没有 → 跳过原因", () => {
    expect(envLockProblem({ docker: { image: "node:22-slim" } }, { docker: false })).toContain("Docker");
    expect(envLockProblem({ docker: { image: "node:22-slim" } }, { docker: true })).toBeNull();
  });
});

describe("公开任务集能加载", () => {
  const root = benchRoot(process.cwd());
  const loaded = loadSuite("harness", root);

  it("7 条任务，id 不重复，train/test 都有", () => {
    expect(loaded.tasks).toHaveLength(7);
    expect(new Set(loaded.tasks.map((t) => t.id)).size).toBe(7);
    expect(loaded.tasks.some((t) => t.split === "train")).toBe(true);
    expect(loaded.tasks.some((t) => t.split === "test")).toBe(true);
  });

  it("每条都有判分（文件或命令），不能是空判分", () => {
    for (const task of loaded.tasks) {
      const files = task.grader.files?.length ?? 0;
      const commands = task.grader.commands?.length ?? 0;
      expect(files + commands, `${task.id} 没有判分口径`).toBeGreaterThan(0);
    }
  });

  it("脚本化任务的 replies 与 turns 等长", () => {
    for (const task of loaded.tasks) {
      if (task.source) continue;
      expect(task.replies?.length, `${task.id} 的 replies 与 turns 不等长`).toBe(task.turns.length);
    }
  });
});

describe("坏任务定义会被挡住", () => {
  const write = (json: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-bench-load-"));
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(json), "utf8");
    return dir;
  };
  const base = { id: "x", title: "x", category: "bugfix", split: "train", turns: ["做"], grader: { files: [{ path: "a" }] } };

  it("缺 id / category 不在表里 / split 写错 / 判分命令为空都直接报错", () => {
    expect(() => normalizeTask({ ...base, id: "" }, ".")).toThrow(/缺 id/);
    expect(() => normalizeTask({ ...base, category: "nope" }, ".")).toThrow(/category/);
    expect(() => normalizeTask({ ...base, split: "dev" }, ".")).toThrow(/split/);
    expect(() => normalizeTask({ ...base, grader: { commands: [{ argv: [] }] } }, ".")).toThrow(/argv/);
  });

  it("加载器不会把坏任务混进批次（写盘的任务 JSON 也要被收窄）", () => {
    const dir = write({ ...base, id: "" });
    expect(() => {
      const file = path.join(dir, "suite.json");
      fs.writeFileSync(file, JSON.stringify({ name: "bad", tasks: ["."] }), "utf8");
      loadSuite(file, path.dirname(dir));
    }).toThrow(/缺 id/);
  });
});
