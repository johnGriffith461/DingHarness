#!/usr/bin/env node
/**
 * 开发入口：**一条命令**把 web dev server 与 Electron 同时拉起来。
 *
 * ## 为什么要有它
 *
 * 在这之前 README 写的是 `pnpm dev:web` + `pnpm electron:dev` 两条命令，
 * 而 `electron:dev` **根本不存在**（package.json 里没有这个 script）。
 * 新来的人照着文档跑，第一步就撞空 —— 这正是"连安装/首跑都做不到"的一部分。
 *
 * ## 它做了什么
 *
 * 1. 先编一次主进程（`pnpm electron:build`）：Electron 的入口是 `dist-electron/`，
 *    不是 `.ts` 源码；不编这一步，改主进程代码不会生效。
 * 2. 起 Vite dev server，等它**真的能返回页面**（探到 `@vite/client` 标记，
 *    与 `electron/main.ts` 的 `probeViteDevServer` 同一判据）。
 * 3. 起 Electron，并把 `VITE_DEV_SERVER_URL` 显式传进去。
 *
 * 任何一边退出，另一边跟着退 —— 不留一个孤儿进程占着 5173。
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const url = "http://localhost:5173/";

/** 主进程入口是编译产物；开发前先编一次。 */
function buildMain() {
  process.stdout.write("· 编译主进程（electron:build）…\n");
  const got = spawnSync(pnpm, ["electron:build"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (got.status !== 0) {
    process.stderr.write("✗ 主进程编译失败 —— 先修上面的报错，再开 dev。\n");
    process.exit(got.status ?? 1);
  }
}

/**
 * 等 Vite 真的能返回页面。
 *
 * 判据与 `electron/main.ts` 的 `probeViteDevServer` 一致：响应里有 `@vite/client`。
 * 只看"端口通了"不够 —— 5173 上任何一个别的服务都会让应用白屏。
 */
async function waitForVite(timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (text.includes("@vite/client")) return;
    } catch {
      /* 还没起来 —— 继续等 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Vite dev server 在 ${timeoutMs / 1000}s 内没有就绪（${url}）`);
}

buildMain();

const vite = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js")], {
  cwd: ROOT,
  stdio: "inherit",
});

let electron = null;
let stopping = false;

/** 两边一起收尾（用户按 Ctrl+C 或任意一边先退出）。 */
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [electron, vite]) {
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
vite.on("exit", (code) => stop(code ?? 0));

try {
  await waitForVite();
} catch (error) {
  process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
  stop(1);
}

const electronBin = require("electron");
process.stdout.write("· Vite 就绪，启动 Electron…\n");
electron = spawn(electronBin, ["."], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
electron.on("exit", (code) => stop(code ?? 0));
