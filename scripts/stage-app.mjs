/**
 * 摆一个**干净的 app 目录**给 electron-builder 打包（`release/app/`）。
 *
 * ## 为什么需要这一步（实测出来的，不是预防性设计）
 *
 * 打包出来的安装包**起不来**：
 *
 * ```
 * ENTRY-LOAD-FAILED Error: Cannot find module 'readable-stream/passthrough'
 *   ← exceljs → archiver → lazystream 要 readable-stream@2 的那个子路径，
 *     而包里顶层那份是 v3.6.2（v3 没有这个子路径）
 * ```
 *
 * 根因是 electron-builder 的 node_modules 收集路径**只保留每个包的一份版本**：
 * 同一个包有多版本时，pnpm 把非顶层那份放在**依赖自己**的 `node_modules/` 下
 * （`node_modules/lazystream/node_modules/readable-stream@2.3.8`），收集器不带它走。
 * **开发态永远看不到**（开发态用的是仓库根那棵完整的树），而 CI 不打包 ——
 * 所以这条一直没被发现，直到 2026-10-14 真去打了一个包。
 *
 * ## 两个条件缺一不可
 *
 * 1. **这份 app 目录里只有生产依赖**（`pnpm install --prod`）。混着 devDependencies 时，
 *    顶层会多出一堆 dev 的传递依赖，"同包多版本"的情况更多、也更难说清。
 *    实测：只装生产依赖的那棵树嵌套是完整的，而且只有 90MB。
 * 2. **`build.files` 里用对象形态**（`{ from, to, filter }`）而不是通配字符串。
 *    通配（`node_modules` 下的递归通配）对 node_modules **不生效** —— 那条路上的 node_modules
 *    由收集器自己决定（实测：加了通配、asra 里照样没有嵌套目录）。
 *    对象形态是"原样拷"，绕开收集器。
 *
 * ⚠️ 它**不碰**仓库根的 `node_modules`：开发、测试、`pnpm build` 的前几步都用那一份。
 *
 * ## 判据
 *
 * 打包产物**真的能不能启动**，由 `scripts/verify-packaged.mjs` 说了算（它会起包、等调试端口）。
 * 本文件里的自检只是让失败提前到"打包之前"。
 *
 * ⚠️ 我自己在这里踩过一个坑：先前用 `asar list | grep "lazystream/node_modules"` 判断，
 * 得到 0 就以为没修好 —— **那是 grep 写错了**：asar 列出的路径用**反斜杠**
 * （`\node_modules\lazystream\...`），我 grep 的是正斜杠，所以永远匹配不到。
 * 结论：**判据要用"包能不能启动"，不要用"我 grep 到了没有"**。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "release", "app");
const DEPS = path.join(ROOT, ".verify", "app-deps");

const step = (msg) => process.stdout.write(`[stage-app] ${msg}\n`);

/** 精简的 app package.json：只留运行时真的需要的字段。 */
function appPackageJson() {
  const root = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return {
    name: root.name,
    version: root.version,
    description: root.description,
    license: root.license,
    type: root.type,
    main: root.main,
    dependencies: root.dependencies,
  };
}

// ① 生产依赖（走仓库自己的 .npmrc：node-linker=hoisted）
mkdirSync(DEPS, { recursive: true });
for (const file of ["package.json", "pnpm-lock.yaml", ".npmrc"]) {
  cpSync(path.join(ROOT, file), path.join(DEPS, file));
}
step("装生产依赖到 .verify/app-deps（--prod，不带 devDependencies）");
execFileSync("pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"], {
  cwd: DEPS,
  stdio: "inherit",
  shell: true,
});

for (const dir of ["dist", "dist-electron"]) {
  if (!existsSync(path.join(ROOT, dir))) {
    console.error(`[stage-app] 缺少 ${dir}/ —— 先跑 pnpm build:web 与 pnpm electron:build`);
    process.exit(1);
  }
}

// ② 摆 app 目录
rmSync(APP, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });
cpSync(path.join(ROOT, "dist"), path.join(APP, "dist"), { recursive: true });
cpSync(path.join(ROOT, "dist-electron"), path.join(APP, "dist-electron"), { recursive: true });
writeFileSync(path.join(APP, "package.json"), `${JSON.stringify(appPackageJson(), null, 2)}\n`, "utf8");
step("拷生产依赖（90MB 量级，不含 dev）");
cpSync(path.join(DEPS, "node_modules"), path.join(APP, "node_modules"), { recursive: true });

/*
 * ③ 自检：**这些嵌套副本在不在**，就是这次修复的判据。
 *
 * 它们不在的话，打出来的包会在启动时以 `Cannot find module` 崩掉 ——
 * 而那类崩溃在开发态永远看不到。所以宁可在打包前红一次。
 *
 * 清单只放"启动路径上真的会 require 到"的那几个；发现新的就在这儿补一条。
 */
const CANARIES = ["lazystream/node_modules/readable-stream/package.json"];
for (const rel of CANARIES) {
  if (!existsSync(path.join(APP, "node_modules", rel))) {
    console.error(`[stage-app] ✗ 嵌套依赖缺失：node_modules/${rel}（打出来的包会启动即崩）`);
    process.exit(1);
  }
}
step(`✓ 嵌套依赖自检通过（${CANARIES.length} 条）`);
step(`✓ app 目录就绪：${path.relative(ROOT, APP)}`);
