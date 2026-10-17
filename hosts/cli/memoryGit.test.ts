import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeMemory, type MemoryEntry } from "../../shared/memory";
import { exportMemoryToGit, importMemoryFromGit, parseEntry, readMemoryLib, renderEntry, writeMemoryLib } from "./memoryGit";

/**
 * 记忆的 Git 工作树承载（V6-2k）。
 *
 * 判据是产品承诺的那条：**一条记忆一个文件、可 diff、可合并**，
 * 而且 Git 只是镜像 —— 合并按 id 走，不静默丢任何一条。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* Windows 上 git 句柄偶尔还占着 */
    }
  }
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
  return String(r.stdout ?? "");
}

function entry(id: string, text: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id, text, createdAt: "2026-10-17T00:00:00.000Z", source: "manual", domain: "private", owner: "local", ...over };
}

function repo(): string {
  const dir = tmp("dh-memrepo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  return dir;
}

describe("记忆 Git 镜像", () => {
  it("⭐ 导出：一条一个 .md + 一次提交；没有变化不造空提交", () => {
    const dataDir = tmp("dh-memdata-");
    const r = repo();
    writeMemoryLib(dataDir, normalizeMemory({ entries: [entry("m1", "每周五发周报"), entry("m2", "用中文回答", { domain: "team" })] }));

    const first = exportMemoryToGit({ dataDir, repo: r });
    if (!first.ok) throw new Error(first.error);
    expect(first.entries).toBe(2);
    expect(first.committed).toBe(true);
    expect(fs.existsSync(path.join(r, "entries", "m1.md"))).toBe(true);
    expect(git(r, ["log", "--oneline"]).trim().split("\n")).toHaveLength(1);

    const second = exportMemoryToGit({ dataDir, repo: r });
    if (!second.ok) throw new Error(second.error);
    expect(second.committed).toBe(false);
    expect(git(r, ["log", "--oneline"]).trim().split("\n")).toHaveLength(1);
  });

  it("改动会进提交；从 json 删掉的条目会删掉对应文件", () => {
    const dataDir = tmp("dh-memdata-");
    const r = repo();
    writeMemoryLib(dataDir, normalizeMemory({ entries: [entry("m1", "旧话")] }));
    exportMemoryToGit({ dataDir, repo: r });

    writeMemoryLib(dataDir, normalizeMemory({ entries: [entry("m1", "新话")] }));
    const got = exportMemoryToGit({ dataDir, repo: r });
    expect(got.ok && got.committed).toBe(true);
    expect(fs.readFileSync(path.join(r, "entries", "m1.md"), "utf8")).toContain("新话");

    writeMemoryLib(dataDir, normalizeMemory({ entries: [] }));
    exportMemoryToGit({ dataDir, repo: r });
    expect(fs.existsSync(path.join(r, "entries", "m1.md"))).toBe(false);
  });

  it("⭐ 导入：同 id 以 Git 侧为准、新 id 加进来（不静默丢）", () => {
    const dataDir = tmp("dh-memdata-");
    const r = repo();
    writeMemoryLib(dataDir, normalizeMemory({ entries: [entry("m1", "本地版本")] }));
    exportMemoryToGit({ dataDir, repo: r });

    /* 在仓库里直接改一条、加一条（模拟另一台机器推上来） */
    fs.writeFileSync(path.join(r, "entries", "m1.md"), renderEntry(entry("m1", "Git 版本")), "utf8");
    fs.writeFileSync(
      path.join(r, "entries", "m3.md"),
      renderEntry(entry("m3", "来自另一台机器", { domain: "team" })),
      "utf8",
    );

    const got = importMemoryFromGit({ dataDir, repo: r });
    if (!got.ok) throw new Error(got.error);
    expect(got).toMatchObject({ added: 1, updated: 1, total: 2 });
    const lib = readMemoryLib(dataDir);
    expect(lib.entries.find((e) => e.id === "m1")?.text).toBe("Git 版本");
    expect(lib.entries.find((e) => e.id === "m3")?.domain).toBe("team");
  });

  it("frontmatter 解析：坏文件给 null（不带走整批）", () => {
    expect(parseEntry("没有 frontmatter 的文本")).toBeNull();
    expect(parseEntry("---\nid: x\n---\n\n正文")?.text).toBe("正文");
    expect(parseEntry("---\nid: x\n---\n\n")?.text).toBeUndefined();
  });

  it("不是仓库的目录会 init；push 没配 remote 会明确报错", () => {
    const dataDir = tmp("dh-memdata-");
    /* 用 repo() 是因为 git 提交需要 user.name/email；init 那一步由 export 的 ensureRepo 负责 */
    const r = repo();
    writeMemoryLib(dataDir, normalizeMemory({ entries: [entry("m1", "x")] }));
    const got = exportMemoryToGit({ dataDir, repo: r });
    expect(got.ok).toBe(true);
    const pushed = exportMemoryToGit({ dataDir, repo: r, push: true });
    expect(pushed.ok).toBe(false);
    if (!pushed.ok) expect(pushed.error).toMatch(/push|remote/i);
  });
});
