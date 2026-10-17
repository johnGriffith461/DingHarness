import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { createWorktree, listWorktrees, mergeWorktree, parseWorktreeList, removeWorktree } from "./worktree";

/**
 * git worktree 会话隔离（V6-2e）。
 *
 * 判据就是产品承诺的那条闭环：**建隔离 → 改 → 合并回主树**，
 * 而且主树脏的时候**拒绝合并**（冲突不该落在用户自己的文件上）。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* Windows 上 git 句柄有时还占着；临时目录不影响判据 */
    }
  }
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
  return String(r.stdout ?? "");
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-worktree-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "原始\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

describe("worktree", () => {
  it("解析 porcelain：路径/分支/detached", () => {
    const text = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.ding-worktrees/x",
      "HEAD def456",
      "branch refs/heads/ding/x",
      "",
      "worktree /tmp/detached",
      "HEAD 999",
      "detached",
    ].join("\n");
    const trees = parseWorktreeList(text);
    expect(trees).toHaveLength(3);
    expect(trees[0]).toMatchObject({ path: "/repo", branch: "main" });
    expect(trees[1]).toMatchObject({ branch: "ding/x" });
    expect(trees[2]?.detached).toBe(true);
  });

  it("⭐ 建隔离 → 改 → 合并回主树（闭环）", () => {
    const root = repo();
    const created = createWorktree({ repo: root, name: "fix-a" });
    if (!created.ok) throw new Error(created.error);
    expect(created.branch).toBe("ding/fix-a");
    expect(fs.existsSync(created.path)).toBe(true);
    expect(listWorktrees(root).some((t) => t.branch === "ding/fix-a")).toBe(true);

    fs.writeFileSync(path.join(created.path, "a.txt"), "改过\n", "utf8");
    const merged = mergeWorktree({ repo: root, name: "fix-a", message: "会话里的改动" });
    if (!merged.ok) throw new Error(merged.error);
    expect(merged.merged).toBe(true);
    /* Windows 上 git 的 autocrlf 会把 LF 写成 CRLF —— 判内容时不跟行尾较劲 */
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("改过\n");
    expect(git(root, ["log", "-1", "--pretty=%s"]).trim()).toBe("merge 会话里的改动");
  });

  it("worktree 里没改动：如实说没合并（不造一个空提交）", () => {
    const root = repo();
    const created = createWorktree({ repo: root, name: "empty" });
    if (!created.ok) throw new Error(created.error);
    const merged = mergeWorktree({ repo: root, name: "empty" });
    if (!merged.ok) throw new Error(merged.error);
    expect(merged.merged).toBe(false);
    expect(merged.note).toContain("没有可合并");
  });

  it("⭐ 主树脏：拒绝合并（冲突不该落在用户自己的改动上）", () => {
    const root = repo();
    const created = createWorktree({ repo: root, name: "dirty" });
    if (!created.ok) throw new Error(created.error);
    fs.writeFileSync(path.join(created.path, "a.txt"), "worktree 改的\n", "utf8");
    fs.writeFileSync(path.join(root, "a.txt"), "主树未提交\n", "utf8");

    const merged = mergeWorktree({ repo: root, name: "dirty" });
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.error).toContain("主树有未提交的改动");
    /* 主树原样（没有被 merge 动过） */
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("主树未提交\n");
    /* worktree 里的改动也还在（没有丢） */
    expect(fs.readFileSync(path.join(created.path, "a.txt"), "utf8")).toBe("worktree 改的\n");
  });

  it("删 worktree（分支保留）", () => {
    const root = repo();
    const created = createWorktree({ repo: root, name: "gone" });
    if (!created.ok) throw new Error(created.error);
    const removed = removeWorktree({ repo: root, name: "gone", force: true });
    expect(removed.ok).toBe(true);
    expect(listWorktrees(root).some((t) => t.branch === "ding/gone")).toBe(false);
  });

  it("名字收窄：路径分隔符/点开头都不行", () => {
    const root = repo();
    expect(createWorktree({ repo: root, name: "../escape" }).ok).toBe(false);
    expect(createWorktree({ repo: root, name: ".hidden" }).ok).toBe(false);
  });
});
