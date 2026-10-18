#!/usr/bin/env node
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PRODUCT_VERSION } from "../../shared/product";
import { KNOWN_FLAGS, parseArgv } from "./args";
import { cmdCommandHelp, cmdHelp } from "./help";

/**
 * `ding` —— **薄入口**（L07，2026-10-18）。
 *
 * ## 为什么只留这么点
 *
 * 冷启动实测（`pnpm perf:budget`）：整条 CLI 的模块图（引擎 + SQLite + 二十几个命令模块）
 * 让 `ding --help` 要 ~300ms，而目标预算是 100ms（单二进制形态）。脚本/CI 里
 * 最常调用的恰恰是 `--version` 与 `--help` —— 它们**不该**为整个引擎付加载成本。
 *
 * 所以：
 * - 这里只做参数解析 + 两条最轻的命令（`--version` / `--help`）；
 * - 其余一律 `import("./main")`（懒加载）—— 真正要用引擎时才付那份钱。
 *
 * ⚠️ 判据与 `main.ts` 里的**同一份**（`parseArgv` / `KNOWN_FLAGS` / `cmdHelp`），
 * 不是另写一套：薄壳只决定"哪些早退"，不改变任何命令的语义。
 */

/** 数据目录（与 `main.ts` 的 `dataDir()` 逐字一致）。 */
function dataDir(): string {
  return (
    process.env.DING_DATA_DIR?.trim() ||
    process.env.DH_DATA_DIR?.trim() ||
    process.env.DSH_CANVAS_DATA_DIR?.trim() ||
    path.join(os.homedir(), ".ding")
  );
}

/** `--version`：优先读**安装包自己的** package.json（补丁版要能如实报）。 */
function printVersion(): never {
  const candidates: string[] = [];
  if (typeof __dirname === "string") {
    candidates.push(path.join(__dirname, "..", "..", "..", "package.json"), path.join(__dirname, "..", "..", "package.json"));
  }
  candidates.push(path.join(process.cwd(), "package.json"));
  let version = PRODUCT_VERSION;
  for (const file of candidates) {
    try {
      const parsedPkg = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; version?: unknown };
      if (parsedPkg.name === "ding-harness" && typeof parsedPkg.version === "string") {
        version = parsedPkg.version;
        break;
      }
    } catch {
      /* 试下一个 */
    }
  }
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

async function entry(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));

  if (parsed.problems?.length) {
    process.stderr.write(`${parsed.problems.map((line) => `参数不对：${line}`).join("\n")}\n`);
    process.exit(2);
  }
  if (parsed.flags.has("version")) printVersion();
  if (parsed.unknown?.length) {
    process.stderr.write(
      `不认识的旗标：${parsed.unknown.map((key) => `--${key}`).join(" / ")}（拼错了？要传字面量就用 -- 隔开）\n` +
        `可用旗标：${[...KNOWN_FLAGS].join(" / ")}\n`,
    );
    process.exit(2);
  }

  const devMode = parsed.flags.has("dev");
  /* 每条命令自己的 `--help`：只加载帮助表，不进引擎 */
  if (parsed.command && (parsed.flags.has("help") || parsed.flags.has("h"))) {
    process.exit(cmdCommandHelp(parsed.command, devMode));
  }
  /* 顶层 `--help` / `ding help` */
  if (parsed.flags.has("help") || parsed.flags.has("h") || parsed.command === "help") {
    process.exit(cmdHelp(devMode, dataDir()));
  }

  /* 其余命令：这时才加载引擎与命令集 */
  const { runMain } = await import("./main");
  await runMain();
}

void entry().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`出错了：${detail}\n`);
  process.exit(1);
});
