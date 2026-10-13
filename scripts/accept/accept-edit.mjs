import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readStoreFile } from "./harness.mjs";

/**
 * 11.27 验收：定时任务的编辑。
 *
 * 三条要验的语义：
 *   1. 编辑改完**保存后下次执行时间必须重算** —— 否则界面显示的还是按旧设置算出来的时间；
 *   2. **执行历史不能被抹掉** —— 那是任务已经干过的事；
 *   3. 编辑已结束（noRepeat 跑过）的任务 → 应**拉回 running** 并按新时间重算
 *      （用户刚改了执行时间，意图显然是"让它按新时间跑"）。
 */
const DATA = "D:/DoubaoWorkClone/.verify/edit-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9670"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9670");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};
const jobsFile = path.join(DATA, "schedules.json");
const readJobs = () => (fs.existsSync(jobsFile) ? readStoreFile(jobsFile) : []);

try {
  await page.locator('[data-testid="wb-nav-scheduled"]').click();
  await page.waitForTimeout(1500);

  // 建一个自定义间隔 60 分钟的任务
  await page.locator('[data-testid="wb-sched-title"]').fill("行业动态");
  await page.locator('[data-testid="wb-sched-prompt"]').fill("给我今天的行业动态前三名");
  await page.locator('[data-testid="wb-sched-repeat"]').selectOption("custom");
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-sched-minutes"]').fill("60");
  await page.locator('[data-testid="wb-sched-create"]').click();
  await page.waitForTimeout(1500);

  const jobs1 = readJobs();
  report.created = jobs1.length;
  report.firstNextRunAt = jobs1[0]?.nextRunAt;
  report.firstMinutes = jobs1[0]?.customMinutes;
  const jobId = jobs1[0]?.id;

  // 跑一次，制造执行历史
  await page.locator(`[data-testid="wb-job-run-${jobId}"]`).click();
  await page.waitForTimeout(3000);
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(2000);
    const j = readJobs()[0];
    if (j?.runs?.length > 0) break;
  }
  const jobs2 = readJobs();
  report.runsAfterRun = jobs2[0]?.runs?.length ?? 0;

  /*
   * 「立刻执行一次」会把视图切到任务页（**有意的**：让用户看见跑起来的任务），
   * 所以列表不在渲染里了，得切回定时任务页再操作。
   */
  await page.locator('[data-testid="wb-nav-scheduled"]').click();
  await page.waitForTimeout(1500);
  report.backOnList = await page.locator(`[data-testid="wb-job-edit-${jobId}"]`).count();

  // 编辑：改名 + 把间隔改成 300 分钟
  await page.locator('[data-testid="wb-job-edit-' + jobId + '"]').click();
  await page.waitForTimeout(800);
  report.editBanner = await page.locator('[data-testid="wb-sched-editing"]').textContent();
  report.prefilledTitle = await page.locator('[data-testid="wb-sched-title"]').inputValue();
  report.prefilledMinutes = await page.locator('[data-testid="wb-sched-minutes"]').inputValue();

  await page.locator('[data-testid="wb-sched-title"]').fill("行业动态（改后）");
  await page.locator('[data-testid="wb-sched-minutes"]').fill("300");
  await page.locator('[data-testid="wb-sched-save"]').click();
  await page.waitForTimeout(1800);

  const jobs3 = readJobs();
  report.afterEditTitle = jobs3[0]?.title;
  report.afterEditMinutes = jobs3[0]?.customMinutes;
  report.afterEditNextRunAt = jobs3[0]?.nextRunAt;
  report.nextRunAtChanged = jobs3[0]?.nextRunAt !== jobs1[0]?.nextRunAt;
  report.runsKept = jobs3[0]?.runs?.length ?? 0;
  report.jobCountUnchanged = jobs3.length;
  report.bannerGone = (await page.locator('[data-testid="wb-sched-editing"]').count()) === 0;

  // 下次执行确实按新间隔算：差值 ≈ (300-60) 分钟
  const deltaMin = Math.round(((jobs3[0]?.nextRunAt ?? 0) - (jobs1[0]?.nextRunAt ?? 0)) / 60000);
  report.nextRunDeltaMinutes = deltaMin;

  // 校验：非法间隔不放行
  await page.locator(`[data-testid="wb-job-edit-${jobId}"]`).click();
  await page.waitForTimeout(700);
  await page.locator('[data-testid="wb-sched-minutes"]').fill("1");
  await page.locator('[data-testid="wb-sched-save"]').click();
  await page.waitForTimeout(1000);
  report.invalidKeptOldValue = readJobs()[0]?.customMinutes;
  report.stillEditing = await page.locator('[data-testid="wb-sched-editing"]').count();

  // 取消编辑
  await page.locator('[data-testid="wb-sched-cancel"]').click();
  await page.waitForTimeout(800);
  report.afterCancelBannerGone = (await page.locator('[data-testid="wb-sched-editing"]').count()) === 0;
  report.afterCancelValueUnchanged = readJobs()[0]?.customMinutes;

  // 重启后仍是改后的值
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2500));
  report.fileOnDiskAfterExit = readJobs().map((j) => ({ title: j.title, minutes: j.customMinutes, runs: j.runs.length }));
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();
}
