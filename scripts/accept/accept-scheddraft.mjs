import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 11.30 验收：任务顶栏的 ⏰ → 用当前任务建定时任务。
 *
 * 两条要验：
 *   1. 跳到定时任务页，且**表单已填好**（标题 + 要做的事）；
 *   2. 草稿是**取走即清**的 —— 离开再回来不能被重新填一遍，
 *      否则用户会以为"上次填的没提交"。
 */
const DATA = "D:/DoubaoWorkClone/.verify/sched-draft";
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const now = Date.now();
fs.writeFileSync(
  path.join(DATA, "tasks.json"),
  JSON.stringify(
    [
      {
        id: "t1",
        title: "行业动态追踪",
        brief: "每天整理三条行业动态并排序",
        createdAt: now,
        stage: "done",
        steps: [{ id: "s1", role: "assistant", text: "好了", at: now }],
        questions: [],
        questionIndex: 0,
        artifacts: [],
      },
    ],
    null,
    2,
  ),
  "utf8",
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9720"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9720");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1800);

const report = {};
try {
  await page.locator('[data-testid="wb-recent-t1"]').click();
  await page.waitForTimeout(1400);
  report.onTaskPage = await page.locator('[data-testid="wb-task-title"]').textContent();

  // 顶栏 ⏰
  await page.locator('[data-testid="wb-task-schedule"]').click();
  await page.waitForTimeout(1600);
  report.onScheduledPage = await page.locator('[data-testid="wb-page-scheduled"]').count();
  report.prefilledTitle = await page.locator('[data-testid="wb-sched-title"]').inputValue();
  report.prefilledPrompt = await page.locator('[data-testid="wb-sched-prompt"]').inputValue();
  report.notEditing = (await page.locator('[data-testid="wb-sched-editing"]').count()) === 0;
  report.createBtnShown = await page.locator('[data-testid="wb-sched-create"]').count();

  // 离开再回来：草稿应已清掉，不再被填
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(900);
  await page.locator('[data-testid="wb-nav-scheduled"]').click();
  await page.waitForTimeout(1400);
  report.afterReturnTitle = await page.locator('[data-testid="wb-sched-title"]').inputValue();
  report.afterReturnPrompt = await page.locator('[data-testid="wb-sched-prompt"]').inputValue();
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();
}
