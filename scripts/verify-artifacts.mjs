/**
 * 交付物新鲜度自检：**安装包必须比源码新**。
 *
 * ## 为什么需要它
 * §73 撞到的那个坑：我 47 轮一直拿 `pnpm electron:build` 当门禁，
 * 而**产出安装包是 `pnpm build` 里另一步 `electron-builder`**。
 * 结果 `release/工作台-0.1.0-setup.exe` 停在 7 小时前，
 * 而所有报告都写着"验收通过" —— 有人拿去装，装的是旧版本。
 *
 * **报告和产物各自都"看起来没问题"，这类偏差在交接时最难发现。**
 *
 * ## 为什么放在打包链里，不放在 `pnpm test` 里
 * 开发期改了源码还没重打包是**正常状态**，若放进单测就会一直红、然后被人删掉。
 * 新鲜度是**发布期**的约束：所以它挂在 `pnpm build` 的最后一步 ——
 * 那次打包刚产出安装包，此时"安装包该比源码新"才对。
 *
 * 用法：node scripts/verify-artifacts.mjs
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** 参与"源码新鲜度"比较的目录与文件。 */
/*
 * ⚠️ 2026-10-16（审计 G94）：原来只有四棵 —— 而本区间新增了两棵**主要源码树**：
 *   · `engine/` 成了默认存储与评测的家；
 *   · `hosts/` 是 server / acp / CLI 的家。
 * 改它们**不会**让安装包判旧 → 一个只改了内核的提交可以带着旧包装发布。
 * （`hosts/` 的 CLI 产物在 dist-cli；桌面包里用的是 engine 的编译产物，两棵都该算。）
 */
const SOURCES = ["src", "electron", "shared", "scripts", "engine", "hosts"];
const FILES = ["package.json", "vite.config.ts", "tsconfig.json", "tsconfig.electron.json"];

/** 安装包所在目录与匹配。 */
const RELEASE = "release";

/**
 * 递归取目录下最新修改时间。
 *
 * @param {string} path 绝对或相对路径
 * @returns {number} 毫秒时间戳；不存在返回 0
 */
function newestMtime(path) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(path, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".git") continue;
      newest = Math.max(newest, newestMtime(full));
    } else {
      newest = Math.max(newest, st.mtimeMs);
    }
  }
  return newest;
}

const srcNewest = Math.max(
  ...SOURCES.map((d) => newestMtime(join(ROOT, d))),
  ...FILES.map((f) => newestMtime(join(ROOT, f))),
);

let setup = null;
let setupMtime = 0;
try {
  for (const name of readdirSync(join(ROOT, RELEASE))) {
    if (!name.endsWith("-setup.exe")) continue;
    const st = statSync(join(ROOT, RELEASE, name));
    if (st.mtimeMs > setupMtime) {
      setup = name;
      setupMtime = st.mtimeMs;
    }
  }
} catch {
  /* release 不存在 —— 下面按"缺失"报 */
}

const fmt = (ms) => (ms ? new Date(ms).toLocaleString("zh-CN") : "（无）");

if (!setup) {
  console.error("✗ 没有找到安装包（release/*-setup.exe）。先跑一次完整打包。");
  process.exit(1);
}

console.log("源码最新修改：" + fmt(srcNewest));
console.log("安装包：" + setup + "  " + fmt(setupMtime));

if (setupMtime < srcNewest) {
  const behindMin = Math.round((srcNewest - setupMtime) / 60000);
  console.error(
    [
      "",
      "✗ 安装包比源码旧 " + behindMin + " 分钟 —— 这份产物**不能**当作当前成果交付。",
      "  （§73 就是这么撞上的：门禁全绿，但 release/ 里的包是 7 小时前的。）",
      "  重跑：pnpm build",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("✓ 安装包比源码新，" + setup + " 是当前源码的产物。");
