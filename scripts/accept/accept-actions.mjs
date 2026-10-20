import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, failOnMarks, pickPort, readStoreFile, shot, waitForPort, dismissFirstRunIfShown } from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

/**
 * 11.19 验收：消息操作栏的六个动作**全部真的能用**。
 *
 * 重点在「重新生成」：它必须是**同一次提问的重跑**，而不是"用现在的上下文又问一遍"。
 * 实现依据是每步存下来的 `askedWith`（当初实际发出去的用户内容）——
 * 光靠"上一条用户消息"重建会拿到不同的上下文。
 * 另外它还必须是**幂等**的：生成前/后步骤数不变（替换，不是追加）。
 */
const DATA = ".verify/actions-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12630]);
const child = spawn(
  "node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: ".", env, stdio: ["ignore", "ignore", "ignore"] },
);
/* 固定等 8 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const ctx = browser.contexts()[0];
await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
const pages = ctx.pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await dismissFirstRunIfShown(page);
await page.waitForTimeout(1500);

const report = {};
const shots = ".verify/shots-final";

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
  report.shareHasRoleLabels = shared.includes("**我：**") && shared.includes("**Ding Harness：**");
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

  /*
   * ══════════ 判定（2026-10-16 补）══════════
   *
   * ⚠️ 这份脚本原来**一条判定都没有** —— 它把 `report` 打出来就退 0。
   * 批跑的分类器把它标成「跑通但没有任何判定」（等于没测），这正是审计说的
   * "静默少测比测试失败更危险"：六个动作全坏掉，它照样绿。
   *
   * 现在把 report 里每一条都变成判定。四类各自堵一种"看着像做了"：
   *   · 复制 —— 提示文案 + **剪贴板里真有那段正文**（只改按钮样式骗不过）；
   *   · 有帮助 / 没帮助 —— 两态互斥 + **落盘**（只改 class 骗不过）；
   *   · 朗读 / 分享 —— 真的在念（`speechSynthesis.speaking`）+ 分享出去的是**带角色标签的 Markdown**；
   *   · ⭐ 重新生成 —— 正文真的变了、**步数不变（替换不是追加）**、步骤 id 不变、`askedWith` 还在。
   *     最后三条是这条脚本的**主柱子**：`askedWith` 是"同一问的重跑"的依据，
   *     少了它就会退化成"用现在的上下文又问一遍"。
   */
  const bad = [];
  const has = (s, needle) => typeof s === "string" && s.includes(needle);
  if (report.error) bad.push("异常：" + report.error);

  if (!report.stepIdFound) bad.push("界面上一个「复制」动作都没有（`wb-act-copy-*`）—— 后面每一条都是在空中点按钮");
  if (!has(report.copyHint, "已复制")) bad.push(`复制之后没有「已复制」的回执（拿到的是 ${JSON.stringify(report.copyHint)}）`);
  const head = String(report.beforeHead ?? "");
  const clip = String(report.clipboardHead ?? "");
  if (!clip) bad.push("剪贴板里没有东西 —— 复制没真写进去（只改了按钮样子？）");
  else if (head && !(head.startsWith(clip) || clip.startsWith(head.slice(0, 8)))) {
    bad.push(`剪贴板里不是这条回复的正文：剪贴板 ${JSON.stringify(clip)} vs 正文 ${JSON.stringify(head)}`);
  }

  if (!has(report.upClass, "is-on")) bad.push("点「有帮助」之后按钮没有进入选中态");
  if (!has(report.downClass, "is-on")) bad.push("点「没帮助」之后按钮没有进入选中态");
  if (has(report.upClassAfterDown, "is-on")) bad.push("点了「没帮助」之后「有帮助」还是选中态 —— 两态该互斥");
  if (report.ratingPersisted !== "down") bad.push(`评级没有落盘（磁盘上是 ${JSON.stringify(report.ratingPersisted)}，界面按的是「没帮助」）`);
  if (!report.askedWithPersisted) bad.push("步骤里没有 `askedWith` ——「重新生成」重跑同一问的依据就没了（会退化成「按现在的上下文又问一遍」）");

  if (report.speaking !== true) bad.push("点「朗读」之后 `speechSynthesis.speaking` 不是 true（没真在念）");
  if (report.stoppedSpeaking === true) bad.push("再点一次没有停下来（`speechSynthesis.speaking` 还是 true）");

  if (!has(report.shareHint, "Markdown")) bad.push(`分享之后没有说明回执（拿到的是 ${JSON.stringify(report.shareHint)}）`);
  if (!report.shareIsMarkdown) bad.push("分享出去的不是 Markdown（没有 `# ` 开头）");
  if (!report.shareHasRoleLabels) bad.push("分享的正文里没有角色标签（`**我：**` / `**Ding Harness：**`）");
  if (!(Number(report.shareLength) > 40)) bad.push(`分享的正文太短（${report.shareLength} 字）—— 可能只复制了标题`);

  if (!report.regenerated) {
    bad.push(`点「重新生成」之后正文没变（前 ${JSON.stringify(report.beforeHead)} / 后 ${JSON.stringify(report.afterHead)}）`);
  }
  if (!report.replacedNotAppended) bad.push(`重新生成应当是**替换**，不是追加（步数 ${report.stepsBefore} → ${report.stepsAfter}）`);
  if (!report.afterRetryStillSameStepId) bad.push("重新生成之后那个步骤没了 —— 它不是同一步的重跑，而是新开了一步");
  if (!report.afterRetryAskedWith) bad.push("重新生成之后 `askedWith` 丢了（下次再重跑就找不到原来那一问了）");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 六个动作都真的能用：复制进了剪贴板 / 评级两态互斥且落盘 / 朗读在念且能停 / 分享是带角色标签的 Markdown / 重新生成换了正文但步数与步骤 id 不变（同一问的重跑）");
  }
}
