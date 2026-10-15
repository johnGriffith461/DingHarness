import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**源码目录里不许躺着编译产物**。
 *
 * ## 为什么这条必须存在
 *
 * `shared/canvas.js` 是一个早年被误提交的编译产物（`tsc` 的 CJS 输出，只有 9 行、
 * 只剩 `Object.defineProperty(exports, "__esModule", ...)`）。
 * 而**模块解析顺序里 `.js` 排在 `.ts` 前面**：
 *   · Vite 默认 `resolve.extensions = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']`
 *   · vitest 同源
 * 于是 `@shared/canvas` 一直解析到那份**空壳 .js**，把真的 `canvas.ts` 顶掉了。
 *
 * 以前这件事**看不出来**：`canvas.ts` 里全是类型，本来就编译成空 —— 顶掉也没人喊。
 * 2026-10-13 给 `canvas.ts` 加了 `migrateCanvasDoc()`（C1 的迁移分支）之后，
 * 6 条测试立刻全红：`TypeError: migrateCanvasDoc is not a function`。
 *
 * ⚠️ 这类问题的形状特别坏：**它平时是绿的**，等到你在那个文件里放第一个运行期值时
 * 才炸，而且报的是"函数不存在"这种指向完全错误的地方的错。
 * 所以这里把它钉死：同名 `.js` 与 `.ts` 不许共存。
 */
const ROOT = path.resolve(__dirname, "..");
const DIRS = ["src", "shared", "electron", "engine", "hosts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-electron", "dist-cli", "release", "data", ".verify", ".git"]);

function collect(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 目录还不存在（例如 `hosts/` 在 CLI 宿主落地之前）—— 跳过，不当成失败
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else out.push(full);
  }
  return out;
}

describe("源码树整洁（编译产物不许混进源码目录）", () => {
  const files = DIRS.flatMap((d) => collect(path.join(ROOT, d)));

  it("没有「同名 .js + .ts」的抢解析组合", () => {
    const base = new Map<string, Set<string>>();
    for (const f of files) {
      const dir = path.dirname(f);
      const ext = path.extname(f);
      if (![".js", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) continue;
      const stem = path.join(dir, path.basename(f, ext));
      if (!base.has(stem)) base.set(stem, new Set());
      base.get(stem)?.add(ext);
    }
    const clashes: string[] = [];
    for (const [stem, exts] of base) {
      // `.ts` + `.js` 同时存在 = 解析会挑 `.js`，源码被顶掉
      if (exts.has(".ts") && (exts.has(".js") || exts.has(".cjs"))) {
        clashes.push(path.relative(ROOT, stem).replace(/\\/g, "/"));
      }
    }
    expect(clashes, "这些地方同时有 .ts 和 .js —— .js 会抢走模块解析，请删掉编译产物").toEqual([]);
  });

  it("扫描范围不是空的（守卫本身别成了空扫描）", () => {
    expect(files.length).toBeGreaterThan(200);
  });
});
