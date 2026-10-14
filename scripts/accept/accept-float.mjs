import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, shot } from "./harness.mjs";

/**
 * 11.10 验收：对话流里的产物卡片 + 悬浮助手窗。
 *
 * 两块断言都是**对着实机形态**来的（`.verify\tour2\09-canvas-entry.png` 与
 * `05-top-icon3.png`）：
 *   · 产物在对话流里是一张卡片（标题 + 创建时间 + 打开），不只是右侧面板里的一行；
 *   · 悬浮窗可拖拽、自带输入区、**问一句答一句但不建任务**。
 */
const DATA = "D:/DoubaoWorkClone/.verify/float-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9580"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:9580");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};

/* ---------- 悬浮助手窗 ---------- */
// 先建一个任务，任务视图里才有顶栏图标
await page.locator('[data-testid="wb-composer-input"]').fill("写一份简短周报");
await page.locator('[data-testid="wb-send"]').click();
await page.waitForTimeout(2000);

const tasksBeforeFloat = await page.locator('[data-testid^="wb-recent-"]').count();

await page.locator('[data-testid="wb-float-open"]').click();
await page.waitForTimeout(800);
report.floatOpened = await page.locator('[data-testid="wb-float"]').count();
report.floatUser = await page.locator('[data-testid="wb-float-user"]').textContent().catch(() => null);
report.floatEmptyShown = await page.locator(".wb-float-empty").count();

// 拖一下：面板位置应改变
const before = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="wb-float"]');
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y) };
});
const head = await page.locator(".wb-float-head").boundingBox();
await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
await page.mouse.down();
await page.mouse.move(head.x + head.width / 2 - 120, head.y + 60, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);
const after = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="wb-float"]');
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y) };
});
report.floatDrag = { before, after, moved: before.x !== after.x || before.y !== after.y };

// 在悬浮窗里问一句 —— 应流式回答
await page.locator('[data-testid="wb-float-input"]').fill("一句话解释什么是现金流");
await page.locator('[data-testid="wb-float-input"]').press("Enter");
let replied = "";
for (let i = 0; i < 30; i += 1) {
  await page.waitForTimeout(1500);
  replied = (await page.locator(".wb-float-reply").first().textContent().catch(() => "")) ?? "";
  if (replied.replace(/[.\s…]/g, "").length > 12) break;
}
report.floatReply = replied.slice(0, 80);
report.floatReplyLength = replied.length;

// **关键：悬浮窗问了不建任务**
const tasksAfterFloat = await page.locator('[data-testid^="wb-recent-"]').count();
report.taskCountUnchanged = { before: tasksBeforeFloat, after: tasksAfterFloat };

await shot(page, "D:/DoubaoWorkClone/.verify/shots-final/wb-16-float.png");

await page.locator('[data-testid="wb-float-close"]').click();
await page.waitForTimeout(500);
report.floatClosed = await page.locator('[data-testid="wb-float"]').count();

/* ---------- 产物卡片 ---------- */
await page.locator('[data-testid="wb-composer-input"]').fill("Word 写一份产品介绍，要标题、卖点列表和一张表格");
await page.locator('[data-testid="wb-send"]').click();
await page.waitForTimeout(2000);

// 答完澄清问题
for (let i = 0; i < 4; i += 1) {
  await page.waitForTimeout(4000);
  if ((await page.locator('[data-testid="wb-question-card"]').count()) === 0) break;
  const options = await page.locator(".wb-option").count();
  if (options > 0) await page.locator('[data-testid="wb-option-0"]').click();
  else await page.locator('[data-testid="wb-custom-send"]').click();
  await page.waitForTimeout(2500);
}

// 等产物卡出现
let cards = 0;
for (let i = 0; i < 40; i += 1) {
  await page.waitForTimeout(3000);
  cards = await page.locator('[data-testid^="wb-artcard-"]').count();
  if (cards > 0) break;
}
report.artifactCards = cards;
report.cardText = await page.locator('[data-testid^="wb-artcard-"]').first().textContent().catch(() => null);
report.cardHasCreatedTime = (report.cardText ?? "").includes("创建时间");
report.cardKindAttr = await page
  .locator('[data-testid^="wb-artcard-"]')
  .first()
  .getAttribute("data-office-artifact-card-kind")
  .catch(() => null);

// 卡片在对话流里（不是右侧面板）
report.cardInsideStream = await page.locator('[data-testid="wb-stream"] [data-testid^="wb-artcard-"]').count();

// 点开
await page.locator('[data-testid^="wb-artcard-open-"]').first().click();
await page.waitForTimeout(1500);
report.afterOpenNote = await page.locator('[data-testid^="wb-artcard-"]').first().textContent().catch(() => null);

await shot(page, "D:/DoubaoWorkClone/.verify/shots-final/wb-17-artcard.png");

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();
