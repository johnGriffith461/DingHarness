import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { closeCanvas, connectWithRetry, openCanvas, pickPort, shot, verdict } from "./harness.mjs";

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

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12640]);
const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
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

  /*
   * ── 画布里的对话侧栏不许把画布压没（2026-10-14 修的真缺陷，这里钉住）──
   *
   * 实测过：只开画布时画布宽 **505**；再把画布里的对话展开 → 画布宽 **0**，
   * 节点被推到右侧面板底下（用户看到的是一块空白 + 一排露出来的卡片边角）。
   * 根因是那个侧栏 `flex: 0 0 300px` 又不肯缩，而它内部"两个下拉 + 按钮 + 说明"
   * 那一行的最小内容宽度 ≈ 507 —— 于是同级的画布只能拿 0。
   *
   * 断言用**比例**不用绝对像素：窗口大小、以后面板宽度调整都不该让它变红，
   * 但"画布被压没"永远该红。
   */
  report.canvasWidthBeforeChat = await page.evaluate(
    () => Math.round(document.querySelector(".react-flow")?.getBoundingClientRect().width ?? -1),
  );
  await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
  await page.waitForTimeout(1600);
  const box = await page.evaluate(() => {
    const flow = document.querySelector(".react-flow")?.getBoundingClientRect();
    const chat = document.querySelector(".wb-canvas > .side")?.getBoundingClientRect();
    const slot = document.querySelector(".wb-canvas")?.getBoundingClientRect();
    return {
      flow: flow ? Math.round(flow.width) : -1,
      chat: chat ? Math.round(chat.width) : -1,
      slot: slot ? Math.round(slot.width) : -1,
    };
  });
  report.chatOpened = box;
  await shot(page, path.join(shots, "wb-24-canvas-with-chat.png"));

  /* 关掉对话，再关画布 */
  await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
  await page.waitForTimeout(800);
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
  const chat = report.chatOpened ?? {};
  const before = report.canvasWidthBeforeChat ?? 0;
  if (chat.flow === undefined) {
    bad.push("没能测到开了对话之后的画布宽度（这一步没做成，这条断言不算数）");
  } else {
    if (chat.flow <= 120) bad.push(`⭐ 打开画布里的对话后，画布只剩 ${chat.flow}px（之前 ${before}px）—— 画布被压没了`);
    if (chat.slot > 0 && chat.chat > chat.slot * 0.6) {
      bad.push(`对话侧栏占了画布区的 ${Math.round((chat.chat / chat.slot) * 100)}%（不该超过 60%：画布才是主角）`);
    }
    if (chat.flow > before) bad.push(`开对话之后画布反而变宽了（${before} → ${chat.flow}），这不合常理`);
  }

  console.error(JSON.stringify({ 画布宽: { 开对话前: before, 开对话后: chat.flow }, 侧栏: chat.chat, 画布区: chat.slot }));
  verdict(bad, "画布打开成立：真加节点并选中 / 开关能收 / **展开对话侧栏后画布仍留得下**");

  await browser.close().catch(() => undefined);
  child.kill();
  process.exit(process.exitCode ?? 0);
}
