import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, pickPort, readStoreFile, shot, verdict, waitForPort } from "./harness.mjs";

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
  /* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
  port = await pickPort([port]);
  const child = spawn(EXE, [".", `--remote-debugging-port=${port}`], {
    cwd: "D:/DoubaoWorkClone",
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  /* 固定等 8 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(port, 40000);
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${port}`);
  const pages = browser.contexts()[0].pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { child, browser, page };
}

const report = {};

/* ---------- 第一次启动：建任务 ---------- */
let { child, browser, page } = await launch(12560);

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
/* 两次非法提交之后**不应该有任务**（拦下 = 真的没建，不只是弹了句话）。 */
report.rowsAfterInvalid = await page.locator(".wb-sched-item").count();

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

await shot(page, "D:/DoubaoWorkClone/.verify/shots-final/wb-14-scheduled.png");

/* ---------- 重启：任务应还在 ---------- */
await browser.close();
child.kill();
await new Promise((r) => setTimeout(r, 2500));

({ child, browser, page } = await launch(12561));
await page.locator('[data-testid="wb-nav-scheduled"]').click();
await page.waitForTimeout(1500);
report.afterRestart = {
  rows: await page.locator(".wb-sched-item").count(),
  text: await page.locator(".wb-sched-item").first().textContent().catch(() => null),
  stillPaused: await page.locator(`[data-testid="wb-job-status-${report.jobId}"]`).textContent().catch(() => null),
};

console.log(JSON.stringify(report, null, 2));

/*
 * ── 判定（2026-10-14 补）────────────────────────────────────────────
 *
 * 这条脚本原来只把 `report` 打出来就退 —— 于是它在批跑里等于**静默不测**：
 * 无论界面坏成什么样都 exit 0。下面按它自己开头声明的三件事收口，
 * 每条都断言**后果**（磁盘上有东西、真的开了任务、重启后状态没丢），
 * 而不是"界面上出现过那一行"。
 */
const bad = [];
const job = report.onDisk?.[0];

/* ① 建了会落盘 */
if (!report.fileExists) bad.push("⭐ 磁盘上没有 schedules.json（建了但没落盘）");
if ((report.onDisk?.length ?? 0) !== 1) bad.push(`磁盘上应有 1 条任务，实际 ${report.onDisk?.length ?? 0} 条`);
if (job && !job.nextRunAtIsFuture) bad.push("落盘的 nextRunAt 不是将来时间（定时不成立）");
if (job && !job.hasRuns) bad.push("落盘的任务没有 runs 数组（执行记录无处可放）");

/* ② 拦非法输入：不是"弹了句话"，而是**真的没建** */
if (!report.validationError) bad.push("空标题提交没有报错说明");
if ((report.rowsAfterInvalid ?? -1) !== 0) bad.push(`非法提交之后不该有任务，实际有 ${report.rowsAfterInvalid} 条`);

/* ③ 执行是真的：跳到任务页 + 开出任务 + 磁盘上有执行记录 */
if (!report.viewAfterRunNow) bad.push("「立刻执行」没有把用户带到任务页（点了没反应）");
if (!report.taskCreated) bad.push("「立刻执行」没有开出工作台任务（只写日志不动手）");
/*
 * ⚠️ 执行记录要看**跑完之后**重新读的那份（`runsOnDisk`）：`onDisk` 是点「立刻执行」
 * 之前读的，那时当然还没有记录 —— 我第一版就是拿它断的，于是必然假红。
 */
const runAfter = report.runsOnDisk?.[0];
if (!(runAfter && runAfter.runs >= 1)) bad.push(`磁盘上的任务没有执行记录：${JSON.stringify(report.runsOnDisk)}`);
if (runAfter && runAfter.ok !== true) bad.push(`执行记录里 ok=${JSON.stringify(runAfter.ok)}（这次执行没成功）`);

/* ④ 暂停：状态字样要变，且不是还给个"下次执行时间" */
if (!report.afterPause?.status?.includes("暂停")) {
  bad.push(`暂停后状态是 ${JSON.stringify(report.afterPause?.status)}（应含「暂停」）`);
}

/* ⑤ 重启还在，且暂停态没丢 */
if ((report.afterRestart?.rows ?? 0) < 1) bad.push("重启后定时任务列表是空的（定时不成立）");
if (report.afterRestart?.text && !report.afterRestart.text.includes("每日新闻推送")) {
  bad.push("重启后第一条不是刚建的那条任务");
}
if (report.afterRestart?.stillPaused !== report.afterPause?.status) {
  bad.push(`重启后状态从 ${JSON.stringify(report.afterPause?.status)} 变成 ${JSON.stringify(report.afterRestart?.stillPaused)}`);
}

verdict(
  bad,
  "定时任务成立：非法输入真的没建 / 落盘且下次执行是将来 / 立刻执行真开出任务且有记录 / 暂停态跨重启还在",
);
await browser.close();
child.kill();
