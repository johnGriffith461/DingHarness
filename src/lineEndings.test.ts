import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 守卫：**本仓的跟踪文件统一 LF**。
 *
 * ## 为什么要钉这一条
 *
 * 这个仓库的 `core.autocrlf` 是 **false**（`git config --get core.autocrlf`）——
 * 也就是说 git 不做任何换行符转换，工作区是什么就存什么。
 * 在这个前提下，只要有一个文件是 CRLF，下面两件事就会发生：
 *
 * 1. **diff 变成整文件重写**：改一行，`git diff` 却报"503 insertions / 472 deletions"。
 *    2026-10-13 就撞过一次（`electron/ipc/driveStore.ts` 被编辑工具改成 CRLF）。
 *    这不是洁癖 —— 它会让**每一次代码复核都失效**：看得出改了什么才是复核的前提。
 * 2. **同一份源码出现两种结尾**：`src/` 是 LF、`scripts/accept/` 是 CRLF（那批脚本当年
 *    由 Python 以文本模式写出，天然带 CRLF）。编辑器/工具对混合结尾的处理各不相同。
 *
 * 所以这条守卫不看功能，只看**字节**：跟踪目录里的文本文件不许含 `\r\n`。
 *
 * ⚠️ 它必须能红：把任意一个文件改成 CRLF，它就得失败（不是"永远绿"的装饰）。
 */
const ROOT = path.resolve(__dirname, "..");

/** 跟踪目录（与 git 里真正入库的范围一致）。构建产物、依赖、临时目录不在内。 */
const DIRS = ["src", "shared", "electron", "scripts", "docs"];
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-electron", "release", "data", ".verify", ".git"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs", ".json", ".css", ".html", ".yml", ".yaml", ".md", ".txt"]);

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (TEXT_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

describe("换行符统一（core.autocrlf=false 前提下的硬约束）", () => {
  const files = DIRS.flatMap((d) => collect(path.join(ROOT, d)));

  it("扫描范围不是空的（守卫本身别成了空扫描）", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("跟踪目录里没有任何 CRLF", () => {
    const crlf = files.filter((f) => readFileSync(f, "utf8").includes("\r\n"));
    expect(
      crlf.map((f) => path.relative(ROOT, f).replace(/\\/g, "/")),
      "这些文件是 CRLF —— 改一行会变成整文件 diff，先统一成 LF",
    ).toEqual([]);
  });

  /**
   * `package.json` / `.oxlintrc.json` 这一层是构建与门禁读的文件，单独再点一次名。
   * 它们不在上面那四个目录里，但同样受"改一行全文件变"的影响。
   */
  it("根目录的配置文件也是 LF", () => {
    for (const f of ["package.json", ".oxlintrc.json", ".gitignore", "vitest.config.ts", "tsconfig.json"]) {
      const s = readFileSync(path.join(ROOT, f), "utf8");
      expect(s.includes("\r\n"), `${f} 含 CRLF`).toBe(false);
    }
  });
});
