/**
 * `ding memory` —— 记忆的查看与 Git 工作树承载（V6-2k）。
 *
 * ```
 * ding memory list
 * ding memory export --git <目录> [--push]   # memory.json → 一条一个 .md + commit
 * ding memory import --git <目录> [--pull]   # .md → 合并回 memory.json
 * ding memory status [--git <目录>]
 * ```
 *
 * Git 是**镜像**，不是第二真相：合并按 id 走，同 id 以 Git 侧为准，不同 id 都保留。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { exportMemoryToGit, importMemoryFromGit, readMemoryLib } from "./memoryGit";
import { flag, type Parsed } from "./args";

function gitDirty(repo: string): number | null {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: path.resolve(repo), encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  return String(r.stdout ?? "").split("\n").filter(Boolean).length;
}

export async function cmdMemory(p: Parsed, dataDir: string): Promise<number> {
  const sub = p.args[0] ?? "list";
  const repo = flag(p, "git");

  if (sub === "list") {
    const lib = readMemoryLib(dataDir);
    if (p.flags.has("json")) {
      process.stdout.write(JSON.stringify(lib, null, 2) + "\n");
      return 0;
    }
    if (!lib.entries.length) {
      process.stdout.write(`记忆是空的（文件：${path.join(dataDir, "memory.json")}）\n`);
      return 0;
    }
    for (const entry of lib.entries) {
      process.stdout.write(
        `· [${entry.domain ?? "private"}${entry.domain === "team" ? "" : `/${entry.owner ?? "local"}`}] ${entry.text}\n` +
          `    ${entry.id}　${entry.createdAt}　${entry.source}\n`,
      );
    }
    return 0;
  }

  if (sub === "export") {
    if (!repo) {
      process.stderr.write("用法：ding memory export --git <目录> [--push]\n");
      return 2;
    }
    const got = exportMemoryToGit({ dataDir, repo: path.resolve(repo), push: p.flags.has("push") });
    if (!got.ok) {
      process.stderr.write(`${got.error}\n`);
      return 1;
    }
    process.stdout.write(
      `✓ 已镜像 ${got.entries} 条到 ${got.repo}\n` +
        `  ${got.committed ? "有新改动，已提交" : "没有变化（不造空提交）"}${got.pushed ? "，已 push" : ""}\n` +
        `  翻看：git -C "${got.repo}" log --oneline -- entries/\n`,
    );
    return 0;
  }

  if (sub === "import") {
    if (!repo) {
      process.stderr.write("用法：ding memory import --git <目录> [--pull]\n");
      return 2;
    }
    const got = importMemoryFromGit({ dataDir, repo: path.resolve(repo), pull: p.flags.has("pull") });
    if (!got.ok) {
      process.stderr.write(`${got.error}\n`);
      return 1;
    }
    process.stdout.write(
      `✓ 合并完成：现有 ${got.total} 条（新增 ${got.added} / 更新 ${got.updated} / 未变 ${got.unchanged}${got.pulled ? "；先 pull 过" : ""}）\n`,
    );
    return 0;
  }

  if (sub === "status") {
    const lib = readMemoryLib(dataDir);
    process.stdout.write(`记忆：${lib.entries.length} 条（${path.join(dataDir, "memory.json")}）\n`);
    if (repo) {
      const dirty = gitDirty(repo);
      process.stdout.write(
        dirty === null
          ? `Git 仓库：${path.resolve(repo)}（不是 git 仓库 / 还没 init）\n`
          : `Git 仓库：${path.resolve(repo)}（未提交改动 ${dirty} 个文件）\n`,
      );
    }
    return 0;
  }

  process.stderr.write("用法：ding memory list|export|import|status [--git <目录>] [--push|--pull]\n");
  return 2;
}
