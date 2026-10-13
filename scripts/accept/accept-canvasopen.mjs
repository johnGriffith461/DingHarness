import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 11.21 验收：点产物卡片 = **在画布里打开**（不是记事本）。
 *
 * 实机的产物卡片点开是画布面板（`openCanvasPanel`），我原来把所有类型都甩给
 * 系统默认程序 —— 打开一个 .md 会蹦出记事本。这条断言要挡住那个回归。
 *
 * 两件事都要验：
 *   1. 文本类产物 → 画布真的显示了、节点真的建出来了、**内容是产物的内容**；
 *   2. Office 类产物 → 仍然交给系统程序（那是**有意分歧**，不能一起改掉）。
 */
const DATA = "D:/DoubaoWorkClone/.verify/canvasopen-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9640"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9640");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};
const shots = "D:/DoubaoWorkClone/.verify/shots-final";

try {
  // 让模型产出一个 HTML 产物（文本类，能在画布里显示）
  await page.locator('[data-testid="wb-composer-input"]').fill(
    "用 html 输出一个单文件页面，标题是「今日待办」，带一个列表。直接给完整 HTML。",
  );
  await page.locator('[data-testid="wb-send"]').click();
  await page.waitForTimeout(2000);

  for (let i = 0; i < 4; i += 1) {
    await page.waitForTimeout(4000);
    if ((await page.locator('[data-testid="wb-question-card"]').count()) === 0) break;
    const options = await page.locator(".wb-option").count();
    if (options > 0) await page.locator('[data-testid="wb-option-0"]').click();
    else await page.locator('[data-testid="wb-custom-send"]').click();
    await page.waitForTimeout(2500);
  }

  // 等产物卡
  let cards = 0;
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(3000);
    cards = await page.locator('[data-testid^="wb-artcard-"]').count();
    if (cards > 0) break;
  }
  report.cards = cards;
  // 没出卡就把模型原文打出来 —— 是"它没吐 artifact 标签"还是"我们没接住"，要能分清
  report.lastReply = (await page.locator(".wb-assistant-text").last().textContent().catch(() => ""))?.slice(0, 400);
  report.replyHasArtifactTag = (report.lastReply ?? "").includes("<artifact");
  if (cards === 0) throw new Error("没有产物卡，无法继续");
  report.cardKind = await page
    .locator('[data-testid^="wb-artcard-"]')
    .first()
    .getAttribute("data-office-artifact-card-kind");

  /*
   * 「画布打开了」不等于「我的节点建出来了」——
   * 画布自带示例节点，直接数节点会被它们混进去。
   * 所以：先开画布数一遍，关掉，再点卡片数一遍，看**增量**。
   */
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);
  const nodesBefore = await page.locator(".react-flow__node").count();
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);
  report.nodesBefore = nodesBefore;

  // 点卡片本体 —— 应在画布里打开
  await page.locator('[data-testid^="wb-artcard-body-"]').first().click();
  await page.waitForTimeout(4000);
  report.canvasAfterClick = await page.locator('[data-testid="wb-canvas"]').count();
  report.nodesAfter = await page.locator(".react-flow__node").count();
  report.nodeDelta = report.nodesAfter - nodesBefore;

  // 新节点应该是被选中的那个（openInCanvas 会选中它）
  report.selectedNodeText = (
    await page.locator(".react-flow__node.selected").first().textContent().catch(() => "")
  )?.slice(0, 70);
  report.selectedHasIframe = await page.locator(".react-flow__node.selected iframe").count();

  await page.screenshot({ path: path.join(shots, "wb-23-canvasopen.png") });

  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);
  report.canvasClosed = await page.locator('[data-testid="wb-canvas"]').count();
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();
}
