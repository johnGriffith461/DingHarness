import fs from "node:fs/promises";
import path from "node:path";

import { rankCandidates, sensitivePathReason, type MentionCandidate } from "../../shared/mentions";

/**
 * `@` 文件/目录候选的**读盘**实现（B1）。
 *
 * 边界：
 * - 只在给定的工作区根内找；路径越界一律不返回（`@` 菜单不是第二个读盘口子）。
 * - 排除 `.git` / `node_modules` / `dist*` / `build` / `vendor` —— 一次列举几十万行没有意义。
 * - 有扫描上限（默认 20000 个条目）：大仓库里不至于为了一个补全把磁盘扫穿。
 */

const EXCLUDED = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-cli",
  "build",
  "release",
  "vendor",
  ".next",
  ".turbo",
  ".cache",
]);

export const WORKSPACE_SCAN_LIMIT = 20_000;

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 按查询词搜文件/目录。
 *
 * @param root 工作区根（绝对路径）
 * @param query `@` 后面的字；空串 = 列顶层
 * @param opts.limit 最多返回几条（默认 20）
 * @param opts.scanLimit 最多扫多少个条目（默认 20000）
 */
export async function searchWorkspaceEntries(
  root: string,
  query: string,
  opts: { limit?: number; scanLimit?: number } = {},
): Promise<MentionCandidate[]> {
  const base = path.resolve(root);
  const found: MentionCandidate[] = [];
  let scanned = 0;
  const scanLimit = opts.scanLimit ?? WORKSPACE_SCAN_LIMIT;
  const q = String(query ?? "").replace(/\\/g, "/").toLowerCase();

  /*
   * 空查询只列顶层：`@` 一敲就该看到"这个工作区里有什么"，
   * 而不是被递归扫出来的 20 个深层目录占满（实测就是这样，连 README.md 都露不出来）。
   */
  if (!q) {
    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (EXCLUDED.has(entry.name)) continue;
          found.push({ kind: "dir", label: entry.name, path: path.join(base, entry.name) });
        } else if (entry.isFile() && !sensitivePathReason(entry.name)) {
          found.push({ kind: "file", label: entry.name, path: path.join(base, entry.name) });
        }
      }
    } catch {
      return [];
    }
    return rankCandidates(found, "", opts.limit ?? 40);
  }

  async function walk(dir: string): Promise<void> {
    if (scanned >= scanLimit) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= scanLimit) return;
      scanned += 1;
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (EXCLUDED.has(entry.name)) continue;
        if (!q || rel.toLowerCase().includes(q)) found.push({ kind: "dir", label: rel, path: full });
        await walk(full);
      } else if (entry.isFile()) {
        if (sensitivePathReason(full)) continue;
        if (!q || rel.toLowerCase().includes(q)) found.push({ kind: "file", label: rel, path: full });
      }
    }
  }

  await walk(base);
  return rankCandidates(found, query, opts.limit ?? 20);
}

/**
 * 列一个目录的直接子项（目录引用展开用）。
 * 越界或读不动返回空数组 —— 调用方据此给出"该目录不可读"。
 */
export async function listWorkspaceDir(root: string, dir: string, limit = 50): Promise<MentionCandidate[]> {
  const base = path.resolve(root);
  const target = path.resolve(base, dir);
  if (!within(base, target)) return [];
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries
      .filter((e) => !EXCLUDED.has(e.name))
      .slice(0, limit)
      .map((e) => ({
        kind: e.isDirectory() ? ("dir" as const) : ("file" as const),
        label: e.name,
        path: path.join(target, e.name),
      }));
  } catch {
    return [];
  }
}

/** 读一个工作区文件（引用展开用）；越界/二进制/敏感文件一律拒绝。 */
export async function readWorkspaceFile(
  root: string,
  file: string,
  opts: { maxBytes?: number } = {},
): Promise<{ ok: true; text: string; path: string } | { ok: false; error: string }> {
  const base = path.resolve(root);
  const target = path.resolve(base, file);
  if (!within(base, target)) return { ok: false, error: "路径不在工作区内" };
  const sensitive = sensitivePathReason(target);
  if (sensitive) return { ok: false, error: sensitive };
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return { ok: false, error: "不是文件" };
    const max = opts.maxBytes ?? 200_000;
    if (stat.size > max) return { ok: false, error: `文件过大（${stat.size} 字节，上限 ${max}）` };
    const buf = await fs.readFile(target);
    if (buf.includes(0)) return { ok: false, error: "看起来是二进制文件" };
    return { ok: true, text: buf.toString("utf8"), path: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
