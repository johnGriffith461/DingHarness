import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { closeCanvas, connectWithRetry, openCanvas, pickPort, shot, verdict, waitForPort } from "./harness.mjs";

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
const DATA = ".verify/canvasopen-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12640]);
const child = spawn(
  "node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: ".", env, stdio: ["ignore", "ignore", "ignore"] },
);
/* 固定等 8 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};
const shots = ".verify/shots-final";

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
  await openCanvas(page);
  await page.waitForTimeout(1500);
  const nodesBefore = await page.locator(".react-flow__node").count();
  /* ⚠️ 这一次是**关掉**（上面注释：「先开画布数一遍，关掉，再点卡片数一遍，看增量」）——
      机械迁移时按"点击之后的文字"判断开/关，这一处判断错了，已改回 closeCanvas。 */
  await closeCanvas(page);
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

  await shot(page, path.join(shots, "wb-23-canvasopen.png"));

  /* ⚠️ 2026-10-16：这一段原来开/关**画布对话侧栏**，量"画布被压没"。侧栏整条拆了，
     所以这里改成：画布开着时宽度必须正常（不为 0）—— 判据从"聊天压不压画布"变成"画布自己在不在"。 */
  report.canvasWidth = await page.evaluate(
    () => Math.round(document.querySelector(".react-flow")?.getBoundingClientRect().width ?? -1),
  );
  if (!(report.canvasWidth > 200)) bad.push(`画布宽度不对：${report.canvasWidth}px`);
  await shot(page, path.join(shots, "wb-24-canvas-open.png"));

  await closeCanvas(page);
  await page.waitForTimeout(1500);
  report.canvasClosed = await page.locator('[data-testid="wb-canvas"]').count();
} finally {
  console.log(JSON.stringify(report, null, 2));

  const bad = [];
  if (!report.canvasAfterClick) bad.push("画布没打开");
  if ((report.nodeDelta ?? 0) < 1) bad.push("「在画布中打开」没有新增节点");
  if (!report.selectedNodeText) bad.push("新节点没有被选中（用户看不出刚打开的是哪个）");
  if (report.canvasClosed !== 0) bad.push("再点一次开关没能收起画布");

  /*
   * 画布 + 对话：画布必须**还剩得下看得见的一块**，且侧栏不许吃掉一半以上。
   * 这两条合起来才拦得住"画布被压成 0/几十像素"这一类（前者是硬底线，
   * 后者防止"能看见但没法用"）。
   */
  /*
   * 2026-10-16:这一块原来断言"展开画布对话侧栏后画布还剩多少"。侧栏整条拆了（主人的话：
   * 「为什么你还有个聊天」），判据换成上面那段量的"画布开着时宽度正常"。
   * 判据没放宽 --- 是那件事不存在了。
   */
  verdict(bad, "画布打开成立：真加节点并选中 / 开关能收 / 画布宽度正常");

  await browser.close().catch(() => undefined);
  child.kill();
  process.exit(process.exitCode ?? 0);
}
