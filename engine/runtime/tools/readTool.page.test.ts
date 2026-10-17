import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readFileForModel } from "./readTool";

/**
 * `read_file` 的分页与**落盘回读**（U02，2026-10-18）。
 *
 * 两件事：
 * ① 大文件（例如 50k 行日志）能按行一段段读回来 —— 这是"截断不丢证据"的最后一环；
 * ② 落盘目录是**额外的只读根**，它不能被当成"哪里都能读"（逃逸必须被拒）。
 */

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-read-"));
  roots.push(dir);
  return dir;
}

describe("read_file 分页", () => {
  it("⭐ 按行切：offset=3, limit=2 拿到第 3、4 行", async () => {
    const dir = tempDir();
    const file = path.join(dir, "log.txt");
    fs.writeFileSync(file, ["l1", "l2", "l3", "l4", "l5"].join("\n"), "utf8");
    const got = await readFileForModel(file, [dir], { page: { offset: 3, limit: 2 } });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.text).toBe("l3\nl4");
    expect(got.fromLine).toBe(3);
    expect(got.totalLines).toBe(5);
  });

  it("offset 越界被**钳住**而不是报错（模型算错一行不该让这一轮白跑）", async () => {
    const dir = tempDir();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "only", "utf8");
    const got = await readFileForModel(file, [dir], { page: { offset: 999 } });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text).toBe("only");
  });

  it("不分页时行为不变（fromLine=1，全文一段）", async () => {
    const dir = tempDir();
    const file = path.join(dir, "b.txt");
    fs.writeFileSync(file, "hello", "utf8");
    const got = await readFileForModel(file, [dir]);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.text).toBe("hello");
      expect(got.fromLine).toBe(1);
      expect(got.truncated).toBe(false);
    }
  });
});

describe("落盘目录是**额外只读根**", () => {
  it("⭐ 白名单外的落盘目录能读（模型回读证据）", async () => {
    const work = tempDir();
    const spill = path.join(tempDir(), "tool-results");
    fs.mkdirSync(spill, { recursive: true });
    const file = path.join(spill, "call.txt");
    fs.writeFileSync(file, "evidence", "utf8");
    const got = await readFileForModel(file, [work], { extraReadDirs: [spill] });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text).toBe("evidence");
  });

  it("⭐ 落盘目录里的 `..` 逃逸被拒（额外只读根不是「哪里都能读」）", async () => {
    const work = tempDir();
    const spill = path.join(tempDir(), "tool-results");
    fs.mkdirSync(spill, { recursive: true });
    const secret = path.join(path.dirname(spill), "secret.txt");
    fs.writeFileSync(secret, "nope", "utf8");
    const got = await readFileForModel(secret, [work], { extraReadDirs: [spill] });
    expect(got.ok).toBe(false);
  });

  it("不在任何根里的路径仍然被拒（这条边界没被放宽）", async () => {
    const work = tempDir();
    const outside = tempDir();
    const file = path.join(outside, "x.txt");
    fs.writeFileSync(file, "x", "utf8");
    const got = await readFileForModel(file, [work], { extraReadDirs: [] });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("不在可读范围内");
  });
});
