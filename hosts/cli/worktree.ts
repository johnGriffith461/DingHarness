import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * git worktree 会话隔离（V6-2e）。
 *
 * ## 为什么是 worktree 而不是"再 clone 一份"
 *
 * 用户要的是"让 agent 在一个隔离的地方改，改完合回来"。worktree 共享同一个
 * `.git`（不复制对象库），却有自己的工作目录与分支 —— 正好是这条需求的形状。
 *
 * ## 边界（如实写）
 *
 * · 只做**本机 git**：不 push、不碰远端、不改用户已有的分支；
 * · 合并前主树必须**干净**：带未提交改动去 merge，冲突会落在用户自己的文件上；
 * · 冲突**不自动解决**：`merge --abort` 回到合并前，把冲突文件列出来让人自己处理；
 * · 分支名固定 `ding/<名字>` —— 删起来不会误删用户自己的分支。
 */

/** `git worktree list --porcelain` 的一条。 */
export type GitWorktree = {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  prunable?: boolean;
};

/** 一次 git 调用的结果（不抛）。 */
type GitOut = { ok: boolean; stdout: string; stderr: string; code: number | null };

function git(args: string[], cwd: string): GitOut {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  return {
    ok: r.status === 0,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
    code: r.status,
  };
}

/** 解析 `git worktree list --porcelain`。 */
export function parseWorktreeList(text: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) out.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (current) {
      if (line.startsWith("HEAD ")) current.head = line.slice(5);
      else if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare") current.bare = true;
      else if (line === "detached") current.detached = true;
      else if (line === "prunable") current.prunable = true;
    }
  }
  if (current) out.push(current);
  return out;
}

/** 仓库根（不在 git 仓库里返回 null）。 */
export function repoRoot(cwd: string): string | null {
  const got = git(["rev-parse", "--show-toplevel"], cwd);
  return got.ok ? got.stdout.trim() : null;
}

/** 名字收窄：只允许字母/数字/`-_.`，且不能以点开头。 */
export function safeWorktreeName(raw: string): string | null {
  const name = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name)) return null;
  return name;
}

/** worktree 落在哪：`<repo>/.ding-worktrees/<名字>`（`.ding-worktrees/` 要进 .gitignore）。 */
export function worktreePath(root: string, name: string): string {
  return path.join(root, ".ding-worktrees", name);
}

/** 分支名：固定前缀，删/合并都不会误碰用户的分支。 */
export function worktreeBranch(name: string): string {
  return `ding/${name}`;
}

/**
 * 把 `.ding-worktrees/` 加进**本仓库的本地排除**（`.git/info/exclude`）。
 *
 * 为什么不改用户的 `.gitignore`：那是一个会被提交、被团队共享的文件；
 * 我们只是在这个仓库里帮用户少一条"主树脏"的误报。`.git/info/exclude` 是本机的。
 */
function ensureExcluded(root: string): void {
  try {
    const gitDir = path.join(root, ".git");
    if (!fs.statSync(gitDir).isDirectory()) return; // worktree 根：.git 是文件，跳过
    const exclude = path.join(gitDir, "info", "exclude");
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (!current.split(/\r?\n/).includes(".ding-worktrees/")) {
      fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}.ding-worktrees/\n`, "utf8");
    }
  } catch {
    /* 排除失败不影响建 worktree（合并时那条判据会如实提示） */
  }
}

/**
 * 建一个 worktree（新分支）。
 *
 * @param opts.repo 仓库根
 * @param opts.name 名字
 * @param opts.base 从哪个 ref 起（默认 HEAD）
 * @returns 路径与分支；失败给出原因
 */
export function createWorktree(opts: { repo: string; name: string; base?: string }): { ok: true; path: string; branch: string } | { ok: false; error: string } {
  const name = safeWorktreeName(opts.name);
  if (!name) return { ok: false, error: "名字只能用字母/数字/-_.（且不能以点开头）" };
  const root = repoRoot(opts.repo);
  if (!root) return { ok: false, error: `这里不是 git 仓库：${opts.repo}` };
  const branch = worktreeBranch(name);
  const dir = worktreePath(root, name);
  if (fs.existsSync(dir)) return { ok: false, error: `这个 worktree 已经存在：${dir}` };
  const existsBranch = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root).ok;
  const args = existsBranch
    ? ["worktree", "add", dir, branch]
    : ["worktree", "add", "-b", branch, dir, opts.base ?? "HEAD"];
  const got = git(args, root);
  if (!got.ok) return { ok: false, error: got.stderr.trim() || got.stdout.trim() || "git worktree add 失败" };
  ensureExcluded(root);
  return { ok: true, path: dir, branch };
}

/** 列出 worktree（只列本仓的）。 */
export function listWorktrees(repo: string): GitWorktree[] {
  const got = git(["worktree", "list", "--porcelain"], repo);
  return got.ok ? parseWorktreeList(got.stdout) : [];
}

/**
 * 把 worktree 的改动**提交并合并回主树**。
 *
 * 顺序：worktree 里 `add -A` + commit（没有改动就如实说没合并）→ 主树必须干净 →
 * `merge --no-ff`。冲突时 `merge --abort` 回到合并前，把冲突文件列出来。
 *
 * @param opts.repo 主仓库根
 * @param opts.name worktree 名
 * @param opts.message 提交信息（默认 `ding worktree: <name>`）
 */
export function mergeWorktree(opts: {
  repo: string;
  name: string;
  message?: string;
}):
  | { ok: true; merged: boolean; branch: string; commit?: string; note: string }
  | { ok: false; error: string; conflicts?: string[] } {
  const name = safeWorktreeName(opts.name);
  if (!name) return { ok: false, error: "名字不合法" };
  const root = repoRoot(opts.repo);
  if (!root) return { ok: false, error: `这里不是 git 仓库：${opts.repo}` };
  const branch = worktreeBranch(name);
  const dir = worktreePath(root, name);
  if (!fs.existsSync(dir)) return { ok: false, error: `没有这个 worktree：${dir}（先 ding worktree start ${name}）` };

  /* ① worktree 里有改动吗 */
  git(["add", "-A"], dir);
  const dirty = !git(["diff", "--cached", "--quiet"], dir).ok;
  if (!dirty) {
    return { ok: true, merged: false, branch, note: "worktree 里没有可合并的改动" };
  }
  const message = opts.message?.trim() || `ding worktree: ${name}`;
  const commit = git(["commit", "-m", message], dir);
  if (!commit.ok) return { ok: false, error: commit.stderr.trim() || "在 worktree 里提交失败" };
  const sha = git(["rev-parse", "--short", "HEAD"], dir).stdout.trim();

  /*
   * ② 主树必须干净 —— 只看**已跟踪**文件。
   *
   * 未跟踪文件不拦：git 在真要覆盖它们时会自己拒绝（"untracked working tree files
   * would be overwritten"），那条错误比我们猜的准；而 `.ding-worktrees/` 本身
   * 通常是未跟踪的，拦它会让每一次合并都要求用户先改 .gitignore。
   */
  const status = git(["status", "--porcelain", "--untracked-files=no"], root);
  if (!status.ok) return { ok: false, error: status.stderr.trim() || "读不到主树状态" };
  if (status.stdout.trim()) {
    return {
      ok: false,
      error: `主树有未提交的改动（已跟踪文件），先提交或 stash 再合并（不然冲突会落在你自己的文件上）：\n${status.stdout.trim().split("\n").slice(0, 8).join("\n")}`,
    };
  }

  /* ③ 合并；冲突就回滚，把文件列出来 */
  const merge = git(["merge", "--no-ff", branch, "-m", `merge ${message}`], root);
  if (!merge.ok) {
    const conflicts = git(["diff", "--name-only", "--diff-filter=U"], root)
      .stdout.split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    git(["merge", "--abort"], root);
    return {
      ok: false,
      error: `合并冲突，已回到合并前（worktree 的分支与提交都还在，处理完再试）`,
      ...(conflicts.length ? { conflicts } : {}),
    };
  }
  return { ok: true, merged: true, branch, commit: sha, note: `已合并 ${branch}（${sha}）` };
}

/**
 * 删一个 worktree（**改动会丢**，调用方要显式确认）。
 *
 * @param opts.repo 仓库根
 * @param opts.name 名字
 * @param opts.force 有未提交改动时也删
 */
export function removeWorktree(opts: { repo: string; name: string; force?: boolean }): { ok: true; path: string } | { ok: false; error: string } {
  const name = safeWorktreeName(opts.name);
  if (!name) return { ok: false, error: "名字不合法" };
  const root = repoRoot(opts.repo);
  if (!root) return { ok: false, error: `这里不是 git 仓库：${opts.repo}` };
  const dir = worktreePath(root, name);
  const got = git(["worktree", "remove", ...(opts.force ? ["--force"] : []), dir], root);
  if (!got.ok) return { ok: false, error: got.stderr.trim() || "git worktree remove 失败（有改动时加 --yes）" };
  return { ok: true, path: dir };
}
