import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 给主进程入口套一层"崩溃也要留话"的壳。
 *
 * 为什么必须这么做：打包后的 Windows 应用起不来时，Electron 只会弹一个标题为
 * `Error` 的原生对话框（内容拿不到、日志也没有），排查只能靠猜。用
 * `dialog.showErrorBox` 太晚（异常已经抛出），所以在**入口最外层**用 try/catch 包住，
 * 把完整堆栈写进临时目录，再原样抛出（不改变原来的失败行为）。
 *
 * 用 Node 写而不是 PowerShell：PS 5.1 的 `Set-Content -Encoding utf8` 会带 BOM。
 * 这里也顺带把 Electron 编译产物从 `.js` 改名为 `.cjs`（原因见下）。
 *
 * ── 为什么要 .cjs ──
 * 根 `package.json` 是 `"type": "module"`。asar 里的入口 `main.js` 会被当成 ESM，
 * 而主进程是 CommonJS 编译的（用 `require`），加载入口直接失败。
 * 用 `.cjs` 把"这是 CommonJS"钉在文件名上，不再依赖任何就近 package.json。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "dist-electron");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

let renamed = 0;
for (const file of walk(outDir)) {
  let text = fs.readFileSync(file, "utf8");
  // require("./ipc/ai") → require("./ipc/ai.cjs")（只改相对路径，裸模块名不动）
  text = text.replace(/(require\(["'])(\.{1,2}\/[^"']+?)(["']\))/g, (_m, a, spec, c) => {
    if (/\.(cjs|json|node)$/.test(spec)) return `${a}${spec}${c}`;
    return `${a}${spec}.cjs${c}`;
  });
  const target = file.replace(/\.js$/, ".cjs");
  fs.writeFileSync(target, text, "utf8");
  fs.unlinkSync(file);
  renamed += 1;
}

// 就近的 commonjs 标记继续保留：对非入口文件仍然有用
fs.writeFileSync(path.join(outDir, "package.json"), '{"type":"commonjs"}\n', "utf8");

const mainPath = path.join(outDir, "electron", "main.cjs");
if (!fs.existsSync(mainPath)) {
  console.error(`[electron-cjs] 预期的主进程产物不存在：${mainPath}`);
  process.exitCode = 1;
} else {
  /**
   * 入口壳：捕获**加载期**的异常（require 失败就发生在这个阶段，
   * 那种情况下常规的 process.on('uncaughtException') 也接不住全部情况）。
   */
  const shell = `"use strict";
// 本文件由 scripts/mark-electron-cjs.mjs 生成：在真正的入口外面套一层崩溃兜底。
(function () {
  try {
    require(${JSON.stringify(`./main.impl.cjs`)});
  } catch (error) {
    try {
      var fs = require("node:fs");
      var os = require("node:os");
      var path = require("node:path");
      var file = path.join(os.tmpdir(), "ding-harness-boot.log");
      fs.appendFileSync(
        file,
        "[" + new Date().toISOString() + "] ENTRY-LOAD-FAILED " +
          ((error && (error.stack || error.message)) || String(error)) + "\\n",
        "utf8",
      );
    } catch (e) {
      /* 兜底日志本身失败也不能掩盖原始错误 */
    }
    throw error;
  }
})();
`;
  const implPath = path.join(outDir, "electron", "main.impl.cjs");
  /**
   * ⭐ **幂等**：这个脚本会被跑很多次（每次 `tsc` 之后都要跑），
   * 而它原来是"把 main.cjs 改名成 main.impl.cjs，再写一个新的 main.cjs 当外壳"。
   *
   * 于是**第二遍**跑的时候：`main.cjs` 已经是**外壳**了 ——
   * 它被改名成 `main.impl.cjs`，而外壳里那句 `require("./main.impl.cjs")`
   * 就变成了**自己 require 自己**。
   *
   * 后果很阴：**不报错、调试端口照开、窗口一个都不建**。
   * （判据：`main.cjs` 与 `main.impl.cjs` 两个文件**大小一模一样**。）
   *
   * 所以：已经套过壳就直接跳过。
   */
  const alreadyShell = fs.existsSync(mainPath) && fs.readFileSync(mainPath, "utf8").includes("main.impl.cjs");
  if (alreadyShell) {
    console.log(
      `[electron-cjs] 已转换 ${renamed} 个文件；入口已经是「外壳 + main.impl.cjs」，跳过套壳`,
    );
  } else {
    fs.renameSync(mainPath, implPath);
    fs.writeFileSync(mainPath, shell, "utf8");
    console.log(
      `[electron-cjs] 已转换 ${renamed} 个文件为 .cjs；入口 = ${path.relative(root, mainPath)}（外壳 + main.impl.cjs）`,
    );
  }
}
