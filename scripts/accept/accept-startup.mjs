import fs from "node:fs";
import { chromium } from "playwright";
import { bootApp, connectWithRetry, freshDir, killTree, waitForPage } from "./harness.mjs";

/**
 * 验收：**桌面启动耗时**（T2）。
 *
 * ## 目标与判据
 *
 * 方案要求「可操作 < 1.5s」。这条给一个**真实数字**，达不到就照实写并指出瓶颈。
 *
 * ## 量什么
 *
 * 三个时刻，都从**进程启动**算（不是从截图开始算，那会漏掉 Electron 冷启动）：
 * 1. `script-start` → `first-frame`：窗口里出现第一帧；
 * 2. `script-start` → `boot`：应用自报 boot 完成（主进程打点）；
 * 3. `script-start` → **输入框可聚焦**：这是"可操作"的判据 ——
 *    用户能开始打字，才算真的能用。
 *
 * 跑 5 次取中位数（冷启动只第一次算冷，所以全部用**新数据目录 + 新进程**，
 * 但 Electron 二进制已在页缓存里 —— 如实注明这一点）。
 */
const RUNS = 5;
const results = [];

for (let i = 1; i <= RUNS; i += 1) {
  const dataDir = `.verify/startup-data-${i}`;
  if (!(await freshDir(dataDir))) {
    console.error(`✗ 数据目录 ${dataDir} 删不掉 —— 先手工关掉占着它的 Electron`);
    process.exit(1);
  }
  const port = 9390 + i;
  let child = null;
  const startedAt = Date.now();
  try {
    const boot = await bootApp({ port, dataDir, timeoutMs: 40000 });
    child = boot.child;
    if (!boot.ok) throw new Error("启动失败：" + (boot.getLog() || "").slice(-400));
    const browser = await connectWithRetry(chromium, `http://127.0.0.1:${port}`);
    const page = await waitForPage(browser);
    if (!page) throw new Error("没有页面");

    /* first-frame：DOM 里出现工作台根 */
    await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
    const firstFrame = Date.now() - startedAt;

    /* 可操作：输入框真的能聚焦并接收输入 */
    const composer = page.locator("textarea").first();
    await composer.waitFor({ timeout: 15000 });
    await composer.focus();
    const focused = await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA");
    const interactive = Date.now() - startedAt;

    /* boot：读主进程的启动打点（如果它记了） */
    let bootAt = null;
    try {
      const perf = await page.evaluate(async () => {
        const shell = globalThis.shell;
        return shell?.perf?.marks ? await shell.perf.marks() : null;
      });
      bootAt = typeof perf?.boot === "number" ? perf.boot : null;
    } catch {
      bootAt = null;
    }

    results.push({ run: i, firstFrame, interactive, bootAt, focused });
    process.stdout.write(
      `第 ${i} 次：first-frame ${firstFrame}ms / 可操作 ${interactive}ms${bootAt === null ? "" : ` / boot ${bootAt}ms`}\n`,
    );
  } catch (error) {
    results.push({ run: i, error: String(error).slice(0, 200) });
    process.stdout.write(`第 ${i} 次：失败 ${String(error).slice(0, 120)}\n`);
  } finally {
    if (child) await killTree(child);
  }
}

const ok = results.filter((r) => !r.error);
const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
};

const summary = {
  runs: results,
  samples: ok.length,
  firstFrameMedian: ok.length ? median(ok.map((r) => r.firstFrame)) : null,
  interactiveMedian: ok.length ? median(ok.map((r) => r.interactive)) : null,
  bootMedian: ok.filter((r) => r.bootAt !== null).length
    ? median(ok.filter((r) => r.bootAt !== null).map((r) => r.bootAt))
    : null,
  target: 1500,
  note:
    "Electron 二进制在页缓存中（同一台机器连续跑 5 次）—— 首次冷启动会更慢。" +
    "每次都是新数据目录 + 新进程。",
};

fs.mkdirSync(".verify", { recursive: true });
fs.writeFileSync(".verify/startup.json", JSON.stringify(summary, null, 2) + "\n", "utf8");

process.stdout.write("\n" + JSON.stringify(summary, null, 2) + "\n");
if (summary.interactiveMedian === null) {
  process.stdout.write("\n✗ 没有一次成功\n");
  process.exit(1);
}
const pass = summary.interactiveMedian < summary.target;
process.stdout.write(
  `\n${pass ? "✓" : "✗"} 目标 ${summary.target}ms / 实测中位数 ${summary.interactiveMedian}ms（${pass ? "达标" : "未达标"}）\n` +
    (pass
      ? ""
      : "  瓶颈：见每次的 first-frame 与可操作之差 —— 差得大说明是渲染/首屏数据初始化，差得小说明是 Electron 冷启动本身。\n"),
);
process.exit(pass ? 0 : 1);
