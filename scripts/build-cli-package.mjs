#!/usr/bin/env node
/**
 * 把仓库根的 `dist-cli/` 拷成可发布的 `packages/cli`（V6-3a）。
 *
 * 为什么不是直接 `npm publish` 仓库根：主仓是 Electron 应用（`private: true`，
 * 带渲染层与桌面依赖）。CLI 包只该带 `dist-cli` + README + LICENSE ——
 * 让 npm 包与桌面产物共用一份 `package.json`，迟早会把 Electron 装进用户机器。
 *
 * 前置：`pnpm cli:build`（已经产出 `dist-cli/`）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "dist-cli");
const PKG = path.join(ROOT, "packages", "cli");
const DEST = path.join(PKG, "dist-cli");

if (!existsSync(SRC)) {
  console.error("没有 dist-cli/：先跑 `pnpm cli:build`。");
  process.exit(1);
}
if (!existsSync(path.join(SRC, "hosts", "cli", "ding.js"))) {
  console.error("dist-cli 里没有 hosts/cli/ding.js —— 产物不完整。");
  process.exit(1);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });

for (const file of ["README.md", "LICENSE"]) {
  const from = path.join(ROOT, file);
  if (existsSync(from)) cpSync(from, path.join(PKG, file));
}

/* bin 的守卫：文件在、首行是 shebang（npm 装出来的 `ding` 靠它直接执行） */
const bin = path.join(PKG, "dist-cli", "hosts", "cli", "ding.js");
if (!existsSync(bin)) {
  console.error(`bin 指向的文件不存在：${path.relative(ROOT, bin)}`);
  process.exit(1);
}
const first = readFileSync(bin, "utf8").split("\n")[0] ?? "";
if (!first.startsWith("#!/usr/bin/env node")) {
  console.error(`bin 首行不是 shebang（实际：${first.slice(0, 60)}）—— npm 装出来会跑不起来。`);
  process.exit(1);
}

let files = 0;
let bytes = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else {
      files += 1;
      bytes += st.size;
    }
  }
};
walk(DEST);

console.log(`✓ packages/cli/dist-cli：${files} 个文件 / ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log("下一步：pnpm cli:pkg:check，然后 cd packages/cli && npm pack --dry-run");
