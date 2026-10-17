/**
 * `ding worktree` —— 用 git worktree 隔离一次会话的改动（V6-2e）。
 *
 * ```
 * ding worktree start fix-npe [--base main] [--dir <仓库>]   # 建隔离工作树 + 分支 ding/fix-npe
 * ding worktree list  [--dir <仓库>]                          # 列出（含主树）
 * ding worktree merge fix-npe [--message "…"]                 # 提交并合并回当前分支（主树必须干净）
 * ding worktree remove fix-npe --yes                          # 删掉（有改动会丢）
 * ```
 *
 * 建完之后跑会话：`ding run "…" --dir <worktree 路径>`（或在那条路径下起 CLI/桌面）。
 */
import path from "node:path";

import { createWorktree, listWorktrees, mergeWorktree, removeWorktree, repoRoot } from "./worktree";
import { flag, type Parsed } from "./args";

/** `--dir` 默认当前目录；再往上找仓库根。 */
function repoOf(p: Parsed): string {
  return path.resolve(flag(p, "dir") ?? process.cwd());
}

export async function cmdWorktree(p: Parsed): Promise<number> {
  const sub = p.args[0] ?? "list";
  const name = p.args[1];
  const repo = repoOf(p);

  if (sub === "start") {
    if (!name) {
      process.stderr.write("用法：ding worktree start <名字> [--base <ref>] [--dir <仓库>]\n");
      return 2;
    }
    const got = createWorktree({ repo, name, ...(flag(p, "base") ? { base: flag(p, "base")! } : {}) });
    if (!got.ok) {
      process.stderr.write(`${got.error}\n`);
      return 1;
    }
    process.stdout.write(
      `✓ 建好了：${got.path}\n` +
        `  分支：${got.branch}（从 ${flag(p, "base") ?? "HEAD"} 起）\n` +
        `  跑会话：ding run "…" --dir "${got.path}"\n` +
        `  合回来：ding worktree merge ${name}\n` +
        `  不需要了：ding worktree remove ${name} --yes\n` +
        `\n⚠️ 把 .ding-worktrees/ 加进 .gitignore（本仓已加；别的仓库要自己加）。\n`,
    );
    return 0;
  }

  if (sub === "list") {
    if (!repoRoot(repo)) {
      process.stderr.write(`这里不是 git 仓库：${repo}\n`);
      return 2;
    }
    const roots = repoRoot(repo)!;
    const trees = listWorktrees(roots);
    if (p.flags.has("json")) {
      process.stdout.write(JSON.stringify(trees, null, 2) + "\n");
      return 0;
    }
    for (const tree of trees) {
      const kind = tree.path === roots ? "主树" : tree.branch?.startsWith("ding/") ? "会话隔离" : "其他";
      process.stdout.write(
        `${kind}　${tree.path}${tree.branch ? `　[${tree.branch}]` : tree.detached ? "　[detached]" : ""}` +
          (tree.prunable ? "　（可清理）" : "") +
          "\n",
      );
    }
    return 0;
  }

  if (sub === "merge") {
    if (!name) {
      process.stderr.write("用法：ding worktree merge <名字> [--message <提交信息>] [--dir <仓库>]\n");
      return 2;
    }
    const got = mergeWorktree({ repo, name, ...(flag(p, "message") ? { message: flag(p, "message")! } : {}) });
    if (!got.ok) {
      process.stderr.write(`${got.error}\n`);
      if (got.conflicts?.length) process.stderr.write(`冲突文件：\n  ${got.conflicts.join("\n  ")}\n`);
      return 1;
    }
    if (!got.merged) {
      process.stdout.write(`${got.note}\n`);
      return 0;
    }
    process.stdout.write(`✓ ${got.note}\n  分支：${got.branch}\n`);
    return 0;
  }

  if (sub === "remove") {
    if (!name) {
      process.stderr.write("用法：ding worktree remove <名字> --yes\n");
      return 2;
    }
    if (!p.flags.has("yes")) {
      process.stderr.write(
        "删 worktree 会丢掉里面没合并的改动。确认之后加 --yes 重跑（不替你决定）。\n",
      );
      return 3;
    }
    const got = removeWorktree({ repo, name, force: true });
    if (!got.ok) {
      process.stderr.write(`${got.error}\n`);
      return 1;
    }
    process.stdout.write(`✓ 删掉了 ${got.path}（分支 ding/${name} 还留着，要删用 git branch -d）\n`);
    return 0;
  }

  process.stderr.write("用法：ding worktree start|list|merge|remove …\n");
  return 2;
}
