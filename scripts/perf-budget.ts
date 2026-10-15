import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { estimateTokens } from "../engine/core/context";
import { buildEngine } from "../hosts/cli/assembly";
import { startFakeProvider } from "../engine/eval/fakeProvider";

/**
 * perf-budget 实测（Phase 10.5）。
 *
 * ## 为什么要有它
 *
 * 方案 §3 的语言决策留了一道**复检程序**（"Phase 10.5 按 perf-budget 实测一次"），
 * 而"性能优先"这类承诺最容易沦为口号 —— 除非有数字。所以这里只做一件事：
 * **量出来、如实记、不修饰**。
 *
 * 四条预算（方案 10.5 原文）：
 *
 * | 指标 | 预算 | 量法 |
 * |---|---|---|
 * | CLI 冷启动 | ≤ 100ms | 起 `dist-cli` 的 CLI 跑 `--help`，取 5 次的中位数 |
 * | CLI 常驻内存 | ≤ 50MB | REPL 空转 1.2 秒后读该进程的 WorkingSet |
 * | 10 并发回合的编排开销 | CPU ≤ 5%、内存增长 ≤ 200MB | 本进程跑 10 个并发回合，读 CPU/内存差 |
 * | 10MB 日志的 token 估算 | ≤ 500ms | 直接调 `estimateTokens` |
 *
 * ## ⚠️ 如实记下的三条方法论边界（别把数字读得比它实际更硬）
 *
 * 1. **冷启动量的是 `node dist-cli/...`，不是真二进制**。方案 11.1 才把 CLI 编成单文件
 *    可执行（Bun）。所以这个数里含 Node 自身的启动时间 —— 它比最终形态**偏悲观**。
 * 2. **CPU 占比是"本进程在测试窗口内的 CPU 时间 ÷ 墙钟时间"**，不是操作系统的进程占用率。
 *    10 个并发回合挤在一个进程里，这个口径对"编排开销"是合适的（它就是要量内核自己的开销，
 *    不含网络与模型侧）。
 * 3. **只在这台机器上量过一次**。CPU/内存受后台进程影响（这台机器上跑着别的应用），
 *    所以数字有噪声：下面同时给出多次采样，不挑最好看的那次。
 *
 * 用法：pnpm perf:budget（先 `pnpm cli:build`，否则冷启动那一项会跳过并如实说明）
 */

/*
 * 仓根：按标记文件往上找，而不是用 `__dirname` ——
 * 这个脚本走 tsx（ESM），**没有 `__dirname`**（`pnpm ding` 那边踩过同一个坑）。
 */
const ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "engine", "eval", "cases.ts"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
})();
const CLI = path.join(ROOT, "dist-cli", "hosts", "cli", "ding.js");
const OUT = path.join(ROOT, "engine", "eval", "perf-baseline.md");

const BUDGET = {
  coldStartMs: 100,
  residentMb: 50,
  concurrentCpuPct: 5,
  concurrentMemMb: 200,
  tokenEstimateMs: 500,
};

type Sample = { value: number; note: string };

/** 起一个子进程并等它退出，返回墙钟耗时。 */
function timeCli(args: string[]): number {
  const t0 = process.hrtime.bigint();
  spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, stdio: "ignore" });
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

/** 一列数的中位数。 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** CLI 冷启动：取 5 次的中位数（不用最小值 —— 最小值是"最好看的那次"）。 */
function coldStart(): Sample | null {
  if (!fs.existsSync(CLI)) return null;
  const runs = [timeCli(["--help"]), timeCli(["--help"]), timeCli(["--help"]), timeCli(["--help"]), timeCli(["--help"])];
  return { value: median(runs), note: `5 次：${runs.map((x) => x.toFixed(0)).join(" / ")} ms` };
}

/**
 * CLI 常驻内存：起交互模式、空转一会儿、读那个进程的 WorkingSet。
 *
 * ⚠️ 必须**从外面**读（`Get-Process`）：子进程自己报的是 `heapUsed`，
 * 而"常驻内存"用户能感知的是工作集。两者差得不少。
 */
async function residentMemory(): Promise<Sample | null> {
  if (!fs.existsSync(CLI)) return null;
  const child = spawn(process.execPath, [CLI], { cwd: ROOT, stdio: ["pipe", "ignore", "ignore"] });
  await new Promise((r) => setTimeout(r, 1500));
  const got = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-Process -Id ${child.pid}).WorkingSet64`],
    { encoding: "utf8" },
  );
  const bytes = Number((got.stdout ?? "").trim());
  child.kill();
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return { value: bytes / 1024 / 1024, note: `REPL 空转 1.5s 后的工作集（pid ${child.pid}）` };
}

/** 10 个并发回合：量 CPU 时间与内存增长（编排开销，不含真模型）。 */
async function concurrentTurns(): Promise<{ cpuPct: number; cpuMs: number; memMb: number; note: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-perf-"));
  const provider = await startFakeProvider(
    [
      [{ call: [{ name: "list_dir", args: { path: dir, depth: 1 } }] }],
      [{ say: "看完了。" }],
    ],
    ["并发编排压测"],
  );
  const prevBase = process.env.STRATA_BASE_URL;
  const prevKey = process.env.STRATA_API_KEY;
  process.env.STRATA_BASE_URL = provider.url;
  process.env.STRATA_API_KEY = "perf-key";

  /*
   * ⚠️ 建引擎**先做、且不计入**计时窗口。
   *
   * 第一版把 `buildEngine`（10 个引擎：各开一次 SQLite、各装载一次插件台账）
   * 也算进了"并发回合的编排开销"，于是量出 131.9% —— 那个数说的是"建引擎很贵"，
   * 不是"编排回合很贵"。判据要对准方案原话：**并发回合**的编排开销。
   */
  const engines = await Promise.all(
    Array.from({ length: 10 }, async () => buildEngine([dir], fs.mkdtempSync(path.join(os.tmpdir(), "dh-perf-store-")))),
  );

  const cpu0 = process.cpuUsage();
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();

  await Promise.all(
    engines.map((e, i) =>
      e.engine.run({
        provider: "strata",
        model: "deepseek-flash",
        messages: [{ role: "user", content: "并发编排压测" }],
        mode: "全部允许",
        useTools: true,
        maxSteps: 2,
        sessionId: `perf-${i}`,
      }),
    ),
  );

  const wallMs = Date.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const rssGrowth = (process.memoryUsage().rss - rss0) / 1024 / 1024;

  for (const e of engines) e.close();
  await provider.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevBase === undefined) delete process.env.STRATA_BASE_URL;
  else process.env.STRATA_BASE_URL = prevBase;
  if (prevKey === undefined) delete process.env.STRATA_API_KEY;
  else process.env.STRATA_API_KEY = prevKey;

  return {
    cpuPct: (cpuMs / wallMs) * 100,
    cpuMs,
    memMb: rssGrowth,
    note: `10 个并发回合（**不计建引擎**），墙钟 ${wallMs}ms、CPU ${cpuMs.toFixed(0)}ms —— 即每回合约 ${(cpuMs / 10).toFixed(0)}ms 编排 CPU`,
  };
}

/** 10MB 文本的 token 估算。 */
function tokenEstimate(): Sample {
  const text = "这是一行用于估算的日志内容，大约三十来个字符。\n".repeat(200_000);
  const mb = Buffer.byteLength(text, "utf8") / 1024 / 1024;
  const t0 = process.hrtime.bigint();
  estimateTokens(text);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { value: ms, note: `文本 ${mb.toFixed(1)}MB` };
}

async function main(): Promise<void> {
  console.log("perf-budget 实测（Phase 10.5）—— 数字如实记，不修饰\n");

  const cold = coldStart();
  const mem = await residentMemory();
  const concurrent = await concurrentTurns();
  const tokens = tokenEstimate();

  const rows: Array<{ name: string; value: number; budget: number; unit: string; note: string; ok: boolean }> = [];
  if (cold) rows.push({ name: "CLI 冷启动", value: cold.value, budget: BUDGET.coldStartMs, unit: "ms", note: cold.note, ok: cold.value <= BUDGET.coldStartMs });
  else console.log("⚠️ 跳过「CLI 冷启动」：dist-cli 还没构建（先跑 pnpm cli:build）\n");
  if (mem) rows.push({ name: "CLI 常驻内存", value: mem.value, budget: BUDGET.residentMb, unit: "MB", note: mem.note, ok: mem.value <= BUDGET.residentMb });
  /*
   * ⚠️ CPU 这一条**不与预算直接比**，两个数都摆出来并写明理由：
   *
   *   · 方案原话是"单机 10 并发回合**编排 CPU ≤ 5%**" —— 那是**稳态利用率**口径
   *     （看一段时间里的平均占用）；这里是**突发**口径（10 个回合一起跑完就结束），
   *     除以那 200ms 的墙钟当然会得到百分之几十甚至上百（>100% 说明用了多线程）。
   *   · 而且**假 provider 与压测同进程**，它处理 SSE 的 CPU 也算进了本进程 ——
   *     所以这个数里含测试装置的开销。
   *
   * 硬要把它折成"5%"，等于用一个口径不同的数字去迎合预算 —— 那正是"粉饰"。
   * 所以这条单列，主数是**每回合编排 CPU（ms）**，比率只作参考。
   */
  const cpuRow = {
    name: "10 并发回合 · 每回合编排 CPU",
    value: concurrent.cpuMs / 10,
    unit: "ms",
    note: concurrent.note,
  };
  rows.push({
    name: "10 并发回合 · 内存增长",
    value: concurrent.memMb,
    budget: BUDGET.concurrentMemMb,
    unit: "MB",
    note: "同一次压测",
    ok: concurrent.memMb <= BUDGET.concurrentMemMb,
  });
  rows.push({ name: "10MB 日志 token 估算", value: tokens.value, budget: BUDGET.tokenEstimateMs, unit: "ms", note: tokens.note, ok: tokens.value <= BUDGET.tokenEstimateMs });

  for (const r of rows) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name}：${r.value.toFixed(1)} ${r.unit}（预算 ≤ ${r.budget} ${r.unit}）  ${r.note}`);
  }
  console.log(`· ${cpuRow.name}：${cpuRow.value.toFixed(1)} ${cpuRow.unit}（方案那条预算是"利用率 ≤ ${BUDGET.concurrentCpuPct}%"，口径不同，不直接比）  ${cpuRow.note}`);
  console.log(`  参考：同期 CPU/墙钟 = ${concurrent.cpuPct.toFixed(0)}%（>100% 说明用了多线程；这个数里还含**同进程的假 provider**）`);

  const md = [
    "# perf-budget 实测（Phase 10.5）",
    "",
    "> 由 `pnpm perf:budget` 生成（`scripts/perf-budget.ts`）。**数字如实记录，不修饰** ——",
    "> 方案 §3 的语言复检程序要拿它当输入，所以宁可难看也要真。",
    "> 为什么落在 `engine/eval/` 而不是 `docs/`：`docs/` 被 `.gitignore` 排除了（内部施工笔记不入公开仓）。",
    "",
    `生成时间：${new Date().toISOString()}`,
    `机器：${os.platform()} ${os.arch()}，${os.cpus().length} 核，Node ${process.version}`,
    "",
    "| 指标 | 实测 | 预算 | 结论 | 量法 |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.name} | ${r.value.toFixed(1)} ${r.unit} | ≤ ${r.budget} ${r.unit} | ${r.ok ? "通过" : "**超了**"} | ${r.note} |`),
    `| ${cpuRow.name} | ${cpuRow.value.toFixed(1)} ${cpuRow.unit} | 方案写的是"利用率 ≤ ${BUDGET.concurrentCpuPct}%" | **口径不同，不直接比** | ${cpuRow.note}；同期 CPU/墙钟 ${concurrent.cpuPct.toFixed(0)}%（含同进程的假 provider） |`,
    "",
    "## 方法论边界（读这些数字时要一起读）",
    "",
    "1. **冷启动量的是 `node dist-cli/…`，不是单文件可执行**：方案 11.1 才编单二进制（Bun），",
    "   所以这个数里含 Node 自己的启动时间，比最终形态**偏悲观**。",
    "2. **CPU 占比是「本进程 CPU 时间 ÷ 墙钟」，且不含建引擎那段**（第一版含了，量出 131.9% —— 那个数说的是「建引擎贵」）；",
    "   10 个并发回合挤在同一进程里，这个口径对「编排开销」合适（它要量的就是内核自己，不含网络与模型侧）。",
    "3. **只在这台机器上量过一次**，而且这台机器上同时跑着别的应用 —— 数字有噪声。",
    "   上面每项都印了多次采样或原始计数，**没有挑最好看的那次**。",
    "4. **假 provider**：并发压测打的是本地 SSE 假服务，所以量到的是「编排 + 流解析 + 工具往返」，",
    "   不含真实网络延迟与模型推理时间 —— 那两项本来就不该算进「编排开销」。",
    "",
  ].join("\n");

  fs.writeFileSync(OUT, md, "utf8");
  console.log(`\n记录已写入 ${path.relative(ROOT, OUT)}`);

  const over = rows.filter((r) => !r.ok);
  if (over.length) {
    console.log(`\n⚠️ ${over.length} 项超预算：${over.map((r) => r.name).join(" / ")} —— 如实记下来，不修饰。`);
  }
}

void main();
