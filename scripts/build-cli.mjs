/**
 * 构建**可发布的 CLI**（Phase 9）。
 *
 * 两件事，都不做会出问题：
 * 1. `tsc -p tsconfig.cli.json` → `dist-cli/`（CommonJS）；
 * 2. 在 `dist-cli/` 放一个 `{"type":"commonjs"}` 标记 ——
 *    根 package.json 是 `"type": "module"`，不放标记的话 Node 会把产物当 ESM 解释，
 *    而它是 CJS（`require` 满天飞）→ 一跑就 `require is not defined`。
 *
 * ⚠️ 顺带自检入口：`dist-cli/hosts/cli/ding.js` 必须存在、且**第一行是 shebang**
 * （bin 靠它执行；tsc 会保留 `.ts` 里的 shebang，但"会不会保留"这种事
 * 不该靠记性 —— 这里当场验一次）。
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist-cli");
const ENTRY = path.join(OUT, "hosts", "cli", "ding.js");

/*
 * ⚠️ **先清空 `dist-cli/`**（2026-10-16，审计 G40）。
 *
 * 不清的代价实测过：目录里留着旧配置编出来的 `dist-cli/src/workbench/**`
 * （那时的 `rootDir/include` 把渲染层也圈进来了），而 `package.json` 的 `files`
 * 是 `dist-cli/` 加通配**全量发布** —— 那一坨死代码会被原样发给用户，
 * 而本地跑 `pnpm build` 看不出任何异常。tsc 自己**不会**删掉不再产出的旧文件。
 */
rmSync(OUT, { recursive: true, force: true });
process.stdout.write("[cli] 编译（tsc -p tsconfig.cli.json）…\n");
/*
 * ⚠️ 直接用**当前 node 跑 typescript 的 JS 入口**，不走 `npx`：
 * Windows 上 `npx` 是 `npx.cmd`，而 Node ≥ 20 起 `spawnSync` 拒绝直接 spawn `.cmd`
 * （`EINVAL`），要用 `shell: true` 才肯 —— 而 `shell: true` 又带参数转义告警。
 * 绕开这两件事最干净的办法就是别找 shim：`node node_modules/typescript/bin/tsc`。
 */
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.cli.json"], {
  cwd: ROOT,
  stdio: "inherit",
});

writeFileSync(path.join(OUT, "package.json"), '{"type":"commonjs"}\n', "utf8");

if (!existsSync(ENTRY)) {
  console.error(`[cli] ✗ 入口没生成：${path.relative(ROOT, ENTRY)}`);
  process.exit(1);
}
const first = readFileSync(ENTRY, "utf8").split("\n")[0] ?? "";
if (!first.startsWith("#!")) {
  console.error(`[cli] ✗ 入口第一行不是 shebang（bin 执行不了）：${JSON.stringify(first)}`);
  process.exit(1);
}
process.stdout.write(`[cli] ✓ dist-cli/ 就绪，入口 ${path.relative(ROOT, ENTRY)}（第一行 ${first.trim()}）\n`);
