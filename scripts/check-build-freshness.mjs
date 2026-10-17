#!/usr/bin/env node
/**
 * 交付门 A：**产物比源码新**。
 *
 * ## 它挡的是什么
 *
 * 2026-10-18 产品审计撞到的事实：`pnpm electron:build` **不重建 web**，
 * 于是 `dist/` 里是一份比 `src/` 旧的界面，测试全绿、应用能开，
 * 但用户看到的是**上一轮的界面**（字标还是旧的、按钮还是旧的）。
 * 这类问题不会让任何一条单测变红 —— 它只能靠"产物与源码的时间关系"挡。
 *
 * ## 判据
 *
 * 每个产物只跟**真正喂它的源码**比，不跟全仓比（否则改一行 CLI 就会让桌面端报过期，
 * 那种误报会让人学会忽略这道门）：
 *
 * | 产物 | 依赖的源码 |
 * |---|---|
 * | `dist/index.html` | `src/`、`shared/`、`index.html`、`vite.config.ts` |
 * | `dist-electron/electron/main.cjs` | `electron/`、`engine/`、`shared/` |
 * | `dist-cli/hosts/cli/ding.js` | `hosts/`、`engine/`、`shared/` |
 *
 * `*.test.ts(x)` 不算：它们不参与构建，改了测试不该要求重建。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-build-freshness.mjs            # 全查（`pnpm start` / `pnpm verify` 用）
 * node scripts/check-build-freshness.mjs --only=cli # 只查一份产物
 * ```
 *
 * 退出码：0 全新鲜；1 有过期/缺失产物（并在 stderr 说清是哪份、旧多少）。
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--root="));
  return arg ? path.resolve(arg.slice("--root=".length)) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
})();

/** 产物 → 喂它的源码（目录或文件，相对仓库根）。 */
const TARGETS = {
  web: {
    output: "dist/index.html",
    sources: ["src", "shared", "index.html", "vite.config.ts", "tsconfig.json", "package.json"],
  },
  electron: {
    output: "dist-electron/electron/main.cjs",
    sources: ["electron", "engine", "shared", "tsconfig.electron.json", "package.json"],
  },
  cli: {
    output: "dist-cli/hosts/cli/ding.js",
    sources: ["hosts", "engine", "shared", "tsconfig.cli.json", "package.json"],
  },
};

/** 这些目录不参与构建。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-electron", "dist-cli", ".verify"]);

/** 测试文件不参与构建。 */
const TEST_FILE = /\.test\.tsx?$/;

/**
 * 目录里最新的一个源文件。
 *
 * @param {string} dir 绝对路径
 * @returns {{ file: string, mtime: number } | null}
 */
function newestIn(dir, out = { file: "", mtime: 0 }) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      newestIn(full, out);
    } else if (entry.isFile() && !TEST_FILE.test(entry.name)) {
      const mtime = statSync(full).mtimeMs;
      if (mtime > out.mtime) {
        out.mtime = mtime;
        out.file = full;
      }
    }
  }
  return out;
}

/**
 * 一份产物依赖的源码里最新的那个。
 *
 * @param {string[]} sources 相对路径
 */
function newestSource(sources) {
  let best = { file: "", mtime: 0 };
  for (const source of sources) {
    const full = path.join(ROOT, source);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue; // 清单里写了一个不存在的路径 —— 不是产物的错，跳过
    }
    if (stat.isDirectory()) {
      newestIn(full, best);
    } else if (stat.mtimeMs > best.mtime) {
      best = { file: full, mtime: stat.mtimeMs };
    }
  }
  return best;
}

const rel = (file) => path.relative(ROOT, file).replaceAll("\\", "/");
const stamp = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean)) : null;

const problems = [];
for (const [name, target] of Object.entries(TARGETS)) {
  if (only && !only.has(name)) continue;
  const output = path.join(ROOT, target.output);
  let outStat;
  try {
    outStat = statSync(output);
  } catch {
    problems.push(`${name}：产物不存在（${target.output}）—— 先跑对应构建命令`);
    continue;
  }
  const source = newestSource(target.sources);
  if (!source.file) continue;
  if (source.mtime > outStat.mtimeMs) {
    const lag = Math.round((source.mtime - outStat.mtimeMs) / 1000);
    problems.push(
      `${name}：${target.output} 比源码旧 ${lag}s（最新源文件：${rel(source.file)}，${stamp(source.mtime)}；产物：${stamp(outStat.mtimeMs)}）`,
    );
  }
}

if (problems.length > 0) {
  process.stderr.write("✗ 产物过期，拒绝按半成品交付：\n");
  for (const line of problems) process.stderr.write(`  · ${line}\n`);
  process.stderr.write("\n修法：`pnpm build:web` / `pnpm electron:build` / `pnpm cli:build`（或直接 `pnpm build`）。\n");
  process.exit(1);
}

const names = Object.keys(TARGETS).filter((n) => !only || only.has(n));
process.stdout.write(`✓ 产物新鲜（${names.join(" / ")}）\n`);
