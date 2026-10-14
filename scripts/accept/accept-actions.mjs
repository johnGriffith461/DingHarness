import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, pickPort, readStoreFile, shot, waitForPort } from "./harness.mjs";

/**
 * 11.19 验收：消息操作栏的六个动作**全部真的能用**。
 *
 * 重点在「重新生成」：它必须是**同一次提问的重跑**，而不是"用现在的上下文又问一遍"。
 * 实现依据是每步存下来的 `askedWith`（当初实际发出去的用户内容）——
 * 光靠"上一条用户消息"重建会拿到不同的上下文。
 * 另外它还必须是**幂等**的：生成前/后步骤数不变（替换，不是追加）。
 */
const DATA = "D:/DoubaoWorkClone/.verify/actions-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12630]);
const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
/* 固定等 8 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const ctx = browser.contexts()[0];
await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
const pages = ctx.pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};
const shots = "D:/DoubaoWorkClone/.verify/shots-final";

try {
  await page.locator('[data-testid="wb-composer-input"]').fill("用三句话说明什么是复利");
  await page.locator('[data-testid="wb-send"]').click();
  await page.waitForTimeout(2000);

  // 答完澄清问题，拿到一条真正的 AI 回复
  for (let i = 0; i < 4; i += 1) {
    await page.waitForTimeout(4000);
    if ((await page.locator('[data-testid="wb-question-card"]').count()) === 0) break;
    const options = await page.locator(".wb-option").count();
    if (options > 0) await page.locator('[data-testid="wb-option-0"]').click();
    else await page.locator('[data-testid="wb-custom-send"]').click();
    await page.waitForTimeout(2500);
  }
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(2000);
    if ((await page.locator(".wb-assistant-text").count()) > 0) break;
  }

  const stepId = await page.locator('[data-testid^="wb-act-copy-"]').first().getAttribute("data-testid");
  const id = (stepId ?? "").replace("wb-act-copy-", "");
  report.stepIdFound = Boolean(id);

  const before = await page.locator(".wb-assistant-text").first().textContent();
  const stepsBefore = await page.locator('[data-testid="wb-message-actions"]').count();

  /* ---------- 复制 ---------- */
  await page.locator(`[data-testid="wb-act-copy-${id}"]`).click();
  await page.waitForTimeout(700);
  report.copyHint = await page.locator(`[data-testid="wb-act-hint-${id}"]`).textContent().catch(() => null);
  report.clipboardHead = (await page.evaluate(() => navigator.clipboard.readText().catch(() => ""))).slice(0, 24);

  /* ---------- 有帮助 / 没帮助（含落盘） ---------- */
  await page.locator(`[data-testid="wb-act-up-${id}"]`).click();
  await page.waitForTimeout(900);
  report.upClass = await page.locator(`[data-testid="wb-act-up-${id}"]`).getAttribute("class");
  await page.locator(`[data-testid="wb-act-down-${id}"]`).click();
  await page.waitForTimeout(1400);
  report.downClass = await page.locator(`[data-testid="wb-act-down-${id}"]`).getAttribute("class");
  report.upClassAfterDown = await page.locator(`[data-testid="wb-act-up-${id}"]`).getAttribute("class");
  const tasksFile = path.join(DATA, "tasks.json");
  const saved = readStoreFile(tasksFile);
  const savedStep = saved[0].steps.find((s) => s.id === id);
  report.ratingPersisted = savedStep?.rating;
  report.askedWithPersisted = typeof savedStep?.askedWith === "string" && savedStep.askedWith.length > 0;

  /* ---------- 朗读 ---------- */
  await page.locator(`[data-testid="wb-act-speak-${id}"]`).click();
  await page.waitForTimeout(1200);
  report.speaking = await page.evaluate(() => window.speechSynthesis?.speaking ?? null);
  await page.locator(`[data-testid="wb-act-speak-${id}"]`).click(); // 停
  await page.waitForTimeout(600);
  report.stoppedSpeaking = await page.evaluate(() => window.speechSynthesis?.speaking ?? null);

  /* ---------- 分享 ---------- */
  await page.locator(`[data-testid="wb-act-share-${id}"]`).click();
  await page.waitForTimeout(900);
  report.shareHint = await page.locator(`[data-testid="wb-act-hint-${id}"]`).textContent().catch(() => null);
  const shared = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  report.shareIsMarkdown = shared.startsWith("# ");
  report.shareHasRoleLabels = shared.includes("**我：**") && shared.includes("**豆包工作：**");
  report.shareLength = shared.length;

  await shot(page, path.join(shots, "wb-22-actions.png"));

  /* ---------- 重新生成 ---------- */
  await page.locator(`[data-testid="wb-act-retry-${id}"]`).click();
  await page.waitForTimeout(3000);
  for (let i = 0; i < 25; i += 1) {
    await page.waitForTimeout(2000);
    const now = await page.locator(".wb-assistant-text").first().textContent();
    if (now && now !== before) break;
  }
  const after = await page.locator(".wb-assistant-text").first().textContent();
  const stepsAfter = await page.locator('[data-testid="wb-message-actions"]').count();
  report.regenerated = after !== before;
  report.stepsBefore = stepsBefore;
  report.stepsAfter = stepsAfter;
  report.replacedNotAppended = stepsBefore === stepsAfter;
  report.retryHint = await page.locator(`[data-testid="wb-act-hint-${id}"]`).textContent().catch(() => null);
  report.beforeHead = (before ?? "").slice(0, 30);
  report.afterHead = (after ?? "").slice(0, 30);

  // 重生成后的步骤仍在磁盘上（且 askedWith 保住）
  await page.waitForTimeout(1500);
  const saved2 = readStoreFile(tasksFile);
  const step2 = saved2[0].steps.find((s) => s.id === id);
  report.afterRetryStillSameStepId = Boolean(step2);
  report.afterRetryAskedWith = typeof step2?.askedWith === "string" && step2.askedWith.length > 0;
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();
}
