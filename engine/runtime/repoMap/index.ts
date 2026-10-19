import fs from "node:fs/promises";
import path from "node:path";

import { buildGraph } from "./graph";
import { parseSymbols, supportedSource, type Symbol } from "./parse";
import { rankSymbols } from "./rank";
import { DEFAULT_MAP_TOKENS, renderMap } from "./render";

/**
 * 仓库地图（E1）：走文件 → 抽符号 → 建引用图 → PageRank → 按预算渲染。
 *
 * 边界（如实）：
 * - 只支持 TS/TSX/JS/JSX（TypeScript 编译器 API）；其它语言**跳过并计数**。
 * - 不引入 `web-tree-sitter`（方案 §11.2 的降级路径）；语言覆盖面因此比 Aider 窄。
 * - `.gitignore` 只按名字排除常见目录（`.git`/`node_modules`/`dist*`/`build`/`vendor`），
 *   不解析完整 gitignore 语法。
 */

export const REPO_MAP_EXCLUDES = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-cli",
  "dist-bin",
  "build",
  "release",
  "vendor",
  ".next",
  ".turbo",
  ".cache",
  ".verify",
  "coverage",
]);

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export type RepoMapResult = {
  text: string;
  files: number;
  symbols: number;
  skipped: number;
  ms: number;
};

export type RepoMapOptions = {
  maxTokens?: number;
  maxFiles?: number;
  chatFiles?: readonly string[];
  mentioned?: readonly string[];
};

export async function buildRepoMap(root: string, opts: RepoMapOptions = {}): Promise<RepoMapResult> {
  const started = Date.now();
  const base = path.resolve(root);
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const files: string[] = [];
  let skipped = 0;

  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (REPO_MAP_EXCLUDES.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (!supportedSource(entry.name)) {
          skipped += 1;
          continue;
        }
        try {
          const stat = await fs.stat(full);
          if (stat.size > DEFAULT_MAX_BYTES) {
            skipped += 1;
            continue;
          }
        } catch {
          skipped += 1;
          continue;
        }
        files.push(full);
      }
    }
  }
  await walk(base);

  const sources = new Map<string, string>();
  const symbols: Symbol[] = [];
  for (const file of files) {
    try {
      const text = await fs.readFile(file, "utf8");
      const rel = path.relative(base, file).split("\\").join("/");
      sources.set(rel, text);
      for (const symbol of parseSymbols(rel, text)) symbols.push(symbol);
    } catch {
      skipped += 1;
    }
  }

  const graph = buildGraph(symbols, sources);
  const ranked = rankSymbols(graph, {
    ...(opts.chatFiles ? { chatFiles: opts.chatFiles } : {}),
    ...(opts.mentioned ? { mentioned: opts.mentioned } : {}),
  });
  const text = renderMap(ranked, { maxTokens: opts.maxTokens ?? DEFAULT_MAP_TOKENS });
  return { text, files: files.length, symbols: symbols.length, skipped, ms: Date.now() - started };
}
