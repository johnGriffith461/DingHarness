import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readStoreFile } from "./harness.mjs";

/**
 * 定时任务真调度的验收（阶段 11.6）。
 *
 * 要证明的是三件事，缺一不可：
 *   1. **建了会落盘** —— 磁盘上真有 `schedules.json`，且里面有这条任务
 *   2. **执行是真的** —— 点「立刻执行」之后有执行记录，且**真的开出了一个工作台任务**
 *      （不是只写一条假日志）
 *   3. **重启还在** —— 关掉再开，任务仍在列表里（否则"定时"不成立）
 *
 * 只看界面上出现了那一行是不够的：那和写死的假数据看不出区别。
 */
const DATA = "D:/DoubaoWorkClone/.verify/sched-data";
fs.rmSync(DATA, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const EXE = "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe";

async function launch(port) {
  const child = spawn(EXE, [".", `--remote-debugging-port=${port}`], {
    cwd: "D:/DoubaoWorkClone",
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise((r) => setTimeout(r, 8000));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = browser.contexts()[0].pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { child, browser, page };
}

const report = {};

/* ---------- 第一次启动：建任务 ---------- */
let { child, browser, page } = await launch(9560);

await page.locator('[data-testid="wb-nav-scheduled"]').click();
await page.waitForTimeout(1200);
report.emptyBefore = await page.locator('[data-testid="wb-sched-empty"]').count();

// 先试一个非法输入：不填标题就建 → 应被拦下并给出说明
await page.locator('[data-testid="wb-sched-create"]').click();
await page.waitForTimeout(400);
report.validationError = await page.locator('[data-testid="wb-sched-error"]').textContent().catch(() => null);

// 非法间隔（custom 填 1 分钟）也应被拦
await page.locator('[data-testid="wb-sched-title"]').fill("每日新闻推送");
await page.locator('[data-testid="wb-sched-prompt"]').fill("汇总今天的行业动态，按重要性排序");
await page.locator('[data-testid="wb-sched-repeat"]').selectOption("custom");
await page.waitForTimeout(300);
await page.locator('[data-testid="wb-sched-minutes"]').fill("1");
await page.locator('[data-testid="wb-sched-create"]').click();
await page.waitForTimeout(400);
report.intervalError = await page.locator('[data-testid="wb-sched-error"]').textContent().catch(() => null);

// 改成合法间隔
await page.locator('[data-testid="wb-sched-minutes"]').fill("5");
await page.locator('[data-testid="wb-sched-create"]').click();
await page.waitForTimeout(1200);

report.jobRows = await page.locator(".wb-sched-item").count();
report.jobText = await page.locator(".wb-sched-item").first().textContent().catch(() => null);
report.jobId = await page.evaluate(() => {
  const el = document.querySelector(".wb-sched-item");
  return el?.getAttribute("data-testid")?.replace("wb-job-", "") ?? null;
});
report.nextLabel = report.jobId
  ? await page.locator(`[data-testid="wb-job-next-${report.jobId}"]`).textContent().catch(() => null)
  : null;
report.statusLabel = report.jobId
  ? await page.locator(`[data-testid="wb-job-status-${report.jobId}"]`).textContent().catch(() => null)
  : null;

// 落盘验证
const file = path.join(DATA, "schedules.json");
report.fileExists = fs.existsSync(file);
if (report.fileExists) {
  const jobs = readStoreFile(file);
  report.onDisk = jobs.map((j) => ({
    title: j.title,
    repeat: j.repeat,
    customMinutes: j.customMinutes,
    env: j.env,
    status: j.status,
    nextRunAtIsFuture: j.nextRunAt > Date.now(),
    hasRuns: Array.isArray(j.runs),
  }));
}

/* ---------- 立刻执行一次：证明执行是真的 ---------- */
await page.locator(`[data-testid="wb-job-run-${report.jobId}"]`).click();
await page.waitForTimeout(6000);

/*
 * 「立刻执行」是**前台**触发，会跳到任务页看结果（这是用户要的反馈）；
 * 而 ticker 在后台触发时**不抢焦点**（否则用户正在干的事会被弹走）。
 * 所以这里先确认它确实跳到了任务页，再回定时任务页继续断言。
 */
report.viewAfterRunNow = await page.locator('[data-testid="wb-task"]').count();
report.taskCreated = await page.locator('[data-testid^="wb-recent-"]').count();
report.recentTitles = await page.$$eval('[data-testid^="wb-recent-"]', (els) =>
  els.map((e) => e.textContent.replace(/\s+/g, " ").trim()),
);

await page.locator('[data-testid="wb-nav-scheduled"]').click();
await page.waitForTimeout(1200);
report.afterRunStatus = await page.locator(`[data-testid="wb-job-status-${report.jobId}"]`).textContent().catch(() => null);
report.afterRunText = await page.locator(".wb-sched-item").first().textContent().catch(() => null);

await page.waitForTimeout(4000);
const jobsAfterRun = readStoreFile(file);
report.runsOnDisk = jobsAfterRun.map((j) => ({ title: j.title, runs: j.runs.length, ok: j.runs[0]?.ok ?? null }));

// 暂停 / 继续
await page.locator(`[data-testid="wb-job-toggle-${report.jobId}"]`).click();
await page.waitForTimeout(800);
report.afterPause = {
  status: await page.locator(`[data-testid="wb-job-status-${report.jobId}"]`).textContent().catch(() => null),
  next: await page.locator(`[data-testid="wb-job-next-${report.jobId}"]`).textContent().catch(() => null),
};

await page.screenshot({ path: "D:/DoubaoWorkClone/.verify/shots-final/wb-14-scheduled.png" });

/* ---------- 重启：任务应还在 ---------- */
await browser.close();
child.kill();
await new Promise((r) => setTimeout(r, 2500));

({ child, browser, page } = await launch(9561));
await page.locator('[data-testid="wb-nav-scheduled"]').click();
await page.waitForTimeout(1500);
report.afterRestart = {
  rows: await page.locator(".wb-sched-item").count(),
  text: await page.locator(".wb-sched-item").first().textContent().catch(() => null),
  stillPaused: await page.locator(`[data-testid="wb-job-status-${report.jobId}"]`).textContent().catch(() => null),
};

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();
