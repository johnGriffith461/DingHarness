import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { isEnvelope, wrap } from "../../shared/persist";
import {
  LOCAL_MEMORY_OWNER,
  MEMORY_DOMAINS,
  normalizeMemory,
  type MemoryEntry,
  type MemoryLib,
} from "../../shared/memory";

/**
 * 记忆域的 **Git 工作树承载**（V6-2k）。
 *
 * ## 为什么
 *
 * 记忆默认在 `memory.json` 里：能读能写，但**看不见历史、不能 diff、不能多机合并**。
 * 把它镜像到一个 Git 仓库（一条记忆一个 `.md`）之后：
 * - 翻看：`git log` / `git show`；
 * - diff：改了哪条、谁改的，一目了然；
 * - 多机：各自推拉同一个仓库即可（冲突是**文件级**的，不会把整份 JSON 覆盖掉）。
 *
 * ## 真相仍是 `memory.json`
 *
 * Git 是**镜像/搬运**，不是第二真相：`export` 从 json 生成文件，`import` 从文件合并回 json。
 * 两边同时改时按 id 合并（同 id 以 Git 侧为准），不同 id 都保留 —— 不静默丢任何一条。
 *
 * ## 文件形状
 *
 * `entries/<id>.md`，带 frontmatter（id / createdAt / source / domain / owner），
 * 正文就是记忆文字。一条一个文件 = 冲突只落在那一条上。
 */

/** 读记忆库（与桌面同一份 `memory.json`，信封/裸数据都认）。 */
export function readMemoryLib(dataDir: string): MemoryLib {
  const file = path.join(dataDir, "memory.json");
  if (!existsSync(file)) return normalizeMemory(null);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return normalizeMemory(isEnvelope(raw) ? raw.data : raw);
  } catch {
    return normalizeMemory(null);
  }
}

/** 写记忆库（原子）。 */
export function writeMemoryLib(dataDir: string, lib: MemoryLib): string {
  const file = path.join(dataDir, "memory.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(wrap(normalizeMemory(lib)), null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return file;
}

/** 一条记忆 → Markdown（含 frontmatter）。 */
export function renderEntry(entry: MemoryEntry): string {
  const lines = [
    "---",
    `id: ${entry.id}`,
    `createdAt: ${entry.createdAt}`,
    `source: ${entry.source}`,
    `domain: ${entry.domain ?? "private"}`,
    `owner: ${entry.owner ?? LOCAL_MEMORY_OWNER}`,
    ...(entry.fromTask ? [`fromTask: ${entry.fromTask.replace(/\r?\n/g, " ")}`] : []),
    "---",
    "",
    entry.text,
    "",
  ];
  return lines.join("\n");
}

/** 从 Markdown 解析一条记忆（坏文件给 null）。 */
export function parseEntry(text: string): MemoryEntry | null {
  const match = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(String(text ?? "").replace(/\r\n/g, "\n"));
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const id = meta.id ?? "";
  const body = match[2]!.trim();
  if (!id || !body) return null;
  const domain = MEMORY_DOMAINS.includes(meta.domain as never) ? (meta.domain as MemoryEntry["domain"]) : "private";
  return {
    id,
    text: body,
    createdAt: meta.createdAt || new Date().toISOString(),
    source: meta.source === "conversation" ? "conversation" : "manual",
    ...(meta.fromTask ? { fromTask: meta.fromTask } : {}),
    domain,
    owner: meta.owner || LOCAL_MEMORY_OWNER,
  };
}

type GitOut = { ok: boolean; stdout: string; stderr: string };
function git(args: string[], cwd: string): GitOut {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  return { ok: r.status === 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

/** 确保目录是一个 git 仓库（空目录就 init）。 */
export function ensureRepo(repo: string): { ok: true; created: boolean } | { ok: false; error: string } {
  if (!existsSync(repo)) {
    mkdirSync(repo, { recursive: true });
    const init = git(["init", "-q", "-b", "main"], repo);
    if (!init.ok) return { ok: false, error: init.stderr.trim() || "git init 失败" };
    return { ok: true, created: true };
  }
  if (git(["rev-parse", "--is-inside-work-tree"], repo).ok) return { ok: true, created: false };
  const init = git(["init", "-q", "-b", "main"], repo);
  if (!init.ok) return { ok: false, error: init.stderr.trim() || "这个目录不是 git 仓库，init 也失败了" };
  return { ok: true, created: true };
}

/**
 * 把 `memory.json` 镜像到 Git 仓库并提交。
 *
 * @param opts.dataDir 数据目录（读 memory.json）
 * @param opts.repo Git 仓库目录
 * @param opts.push 提交后是否 push（需要已配 remote；默认不推）
 */
export function exportMemoryToGit(opts: { dataDir: string; repo: string; push?: boolean }):
  | { ok: true; entries: number; committed: boolean; pushed: boolean; repo: string }
  | { ok: false; error: string } {
  const ready = ensureRepo(opts.repo);
  if (!ready.ok) return ready;
  const lib = readMemoryLib(opts.dataDir);
  const dir = path.join(opts.repo, "entries");
  mkdirSync(dir, { recursive: true });

  /* 先写/更新；再删掉那些"记忆里已经没有了"的文件（只删我们写的 .md） */
  const keep = new Set<string>();
  for (const entry of lib.entries) {
    const file = path.join(dir, `${entry.id}.md`);
    keep.add(`${entry.id}.md`);
    writeFileSync(file, renderEntry(entry), "utf8");
  }
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || keep.has(name)) continue;
    const full = path.join(dir, name);
    try {
      if (parseEntry(readFileSync(full, "utf8"))) rmSync(full, { force: true });
    } catch {
      /* 不是我们的文件：不动 */
    }
  }

  git(["add", "-A"], opts.repo);
  const staged = git(["diff", "--cached", "--quiet"], opts.repo);
  const committed = !staged.ok;
  if (committed) {
    const message = `memory: sync ${new Date().toISOString().slice(0, 16).replace("T", " ")}（${lib.entries.length} 条）`;
    const commit = git(["commit", "-q", "-m", message], opts.repo);
    if (!commit.ok) {
      /* 没配 user.name/email 时 git 会拒；给一句能照着做的话 */
      return { ok: false, error: commit.stderr.trim() || "提交失败（这个仓库配 user.name/user.email 了吗？）" };
    }
  }
  let pushed = false;
  if (opts.push) {
    const push = git(["push"], opts.repo);
    if (!push.ok) return { ok: false, error: push.stderr.trim() || "push 失败（配 remote 了吗？）" };
    pushed = true;
  }
  return { ok: true, entries: lib.entries.length, committed, pushed, repo: opts.repo };
}

/**
 * 从 Git 仓库合并回 `memory.json`。
 *
 * 合并口径：**同 id 以 Git 侧为准**（文件是用户可编辑的那一面），不同 id 都保留。
 *
 * @param opts.dataDir 数据目录
 * @param opts.repo Git 仓库目录
 * @param opts.pull 合并前是否 `git pull --ff-only`
 */
export function importMemoryFromGit(opts: { dataDir: string; repo: string; pull?: boolean }):
  | { ok: true; total: number; added: number; updated: number; unchanged: number; pulled: boolean }
  | { ok: false; error: string } {
  if (!existsSync(path.join(opts.repo, "entries"))) {
    return { ok: false, error: `仓库里没有 entries/：${opts.repo}（先 export 一次）` };
  }
  let pulled = false;
  if (opts.pull) {
    const pull = git(["pull", "--ff-only", "--quiet"], opts.repo);
    if (!pull.ok) return { ok: false, error: pull.stderr.trim() || "git pull 失败（有分叉或没配 remote）" };
    pulled = true;
  }
  const dir = path.join(opts.repo, "entries");
  const incoming: MemoryEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    try {
      const entry = parseEntry(readFileSync(path.join(dir, name), "utf8"));
      if (entry) incoming.push(entry);
    } catch {
      /* 坏文件跳过（不带走整批） */
    }
  }

  const current = readMemoryLib(opts.dataDir);
  const byId = new Map(current.entries.map((entry) => [entry.id, entry]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const entry of incoming) {
    const existing = byId.get(entry.id);
    if (!existing) {
      added += 1;
      byId.set(entry.id, entry);
      continue;
    }
    if (existing.text !== entry.text || existing.domain !== entry.domain || existing.owner !== entry.owner) {
      updated += 1;
      byId.set(entry.id, entry);
    } else {
      unchanged += 1;
    }
  }
  const entries = [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  writeMemoryLib(opts.dataDir, { ...current, entries });
  return { ok: true, total: entries.length, added, updated, unchanged, pulled };
}
