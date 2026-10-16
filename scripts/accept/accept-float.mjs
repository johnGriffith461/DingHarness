import { chromium } from "playwright";
import { bootApp, connectWithRetry, failOnMarks, freshDir, killTree, pickPort, shot } from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

/**
 * 11.10 验收：对话流里的产物卡片 + 悬浮助手窗。
 *
 * 两块断言都是**对着实机形态**来的（`.verify\tour2\09-canvas-entry.png` 与
 * `05-top-icon3.png`）：
 *   · 产物在对话流里是一张卡片（标题 + 创建时间 + 打开），不只是右侧面板里的一行；
 *   · 悬浮窗可拖拽、自带输入区、**问一句答一句但不建任务**。
 */
const DATA = ".verify/float-data";
/*
 * ⚠️ 2026-10-16（主人的要求：把清单外的脚本并进批跑）：这份脚本原来**自己 spawn Electron**
 * （裸 `spawn` + `waitForPort` + `connectOverCDP`）—— 这台机器上存在
 * 「TCP 通、但 Electron 的调试服务器不答」的端口区间，于是它会**卡在连 CDP 那一步**
 * （实测：整条脚本 200 秒一个字都没打出来）。换成 `bootApp`：它真的问一次 CDP，
 * 不通就换底座重试；顺带给应用打上批跑的标记（清残留时才认领得到它，不误伤别人的进程）。
 */
await freshDir(DATA);
const booted = await bootApp({ port: await pickPort([12580]), dataDir: DATA, timeoutMs: 40_000 });
if (!booted.ok) {
  console.error("[诊断] 应用输出尾部：" + (booted.getLog() || "(空)").slice(-1200));
  await killTree(booted.child);
  process.exit(1);
}
const browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};

/* ---------- 悬浮助手窗 ---------- */
// 先建一个任务，任务视图里才有顶栏图标
/*
   * ⚠️ 提示词里的「请产出一个 markdown 产物」是**批跑假通道的装置标记**
   * （与工具那一路的「请调用 <名字> 工具」同一套口径）：
   * 这条脚本要验的是"对话流里出现产物卡片、点开能打开"，而**谁来产出那个产物**
   * 原来只能靠真模型 —— 于是它一直进不了批跑。判据没变，变的只是装置。
   */
  await page.locator('[data-testid="wb-composer-input"]').fill("请产出一个 markdown 产物：写一份简短周报。");
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

await shot(page, ".verify/shots-final/wb-16-float.png");

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

await shot(page, ".verify/shots-final/wb-17-artcard.png");

console.log(JSON.stringify(report, null, 2));
await browser.close();
await killTree(booted.child);
