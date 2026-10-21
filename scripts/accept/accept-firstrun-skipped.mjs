// 首跑向导的**跳步要能解释、能回退**（2026-10-21 主人实测）—— 常驻回归。
//
// 场景：用户重新下载安装包，但他的 `~/.ding/.credentials.yaml` 里还留着以前配的 key
// （重装软件不会删主目录里的凭据）。于是向导判定"你已经配过"，直接跳到第 3 步，
// 前两步显示成灰的 —— 用户第一眼是"这两步我没做过，怎么就打勾了"。
//
// 判据（全是行为）：
//   ① 落在第 3 步时，卡片上有说明条，写清"已跳过前两步"与凭据来自 `~/.ding`；
//   ② 前两步的标题**不是删除线**（那会被读成"作废"），而是 ✓ + 常规灰；
//   ③ 点「我要重新配一遍」→ 回到第 1 步，provider 下拉能用；
//   ④ 第 1 步的「换一家」、第 2 步的「重新填一条」也都能到达对应输入；
//   ⑤ 全程没有假装成"你做过"：第 2 步跳过的说明里点名用的是哪一条 keyRef。
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { failOnMarks, freshDir, killLeftovers, killTree, pickPort, sleep, bootApp, connectWithRetry, waitForPage, verdict } from "./harness.mjs";

failOnMarks();

const bad = [];
const note = (m) => console.log("   " + m);

const DATA = ".verify/accept-firstrun-skipped-data";
const CREDS = ".verify/accept-firstrun-skipped-creds";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
await freshDir(CREDS);
fs.mkdirSync(CREDS, { recursive: true });
/* 只让"本应用"那一格有 key（app 来源）—— 这正是用户机器上的情形 */
const CRED_FILE = path.join(CREDS, "credentials.yaml");
fs.writeFileSync(CRED_FILE, "refs:\n  STRATA_API_KEY: accept-app-saved-key\n", "utf8");

const port = await pickPort([9931]);
await killLeftovers();
const booted = await bootApp({
  port,
  dataDir: DATA,
  timeoutMs: 40_000,
  extraEnv: { DING_CREDENTIALS_FILE: CRED_FILE, STRATA_API_KEY: "" },
});
if (!booted.ok) {
  console.error("✗ 应用没起来：" + (booted.getLog() || "").slice(-600));
  process.exit(1);
}

let browser;
try {
  browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
  /* 这条就是要验向导：别让 harness 替我们点掉它 */
  const page = await waitForPage(browser, 20000, { keepFirstRun: true });
  await page.waitForSelector('[data-testid="wb-firstrun"]', { timeout: 20000 });
  await sleep(1500);

  const steps = page.locator(".wb-firstrun-steps > li");
  const active = await steps.nth(2).getAttribute("data-active");
  if (active !== "true") bad.push(`有本应用保存的 key 时，向导没落在第 3 步（第 3 步 data-active=${active}）`);
  else note("落点：第 3 步（选模型 + 工作区）✓");

  /* ① 说明条：必须说清为什么跳过、key 从哪来 */
  const notice = page.locator('[data-testid="wb-firstrun-skipped"]');
  if (!(await notice.count())) bad.push("⭐ 跳步没有说明条 —— 用户只会看到两步莫名其妙被划掉");
  else {
    const text = ((await notice.innerText()) ?? "").replace(/\s+/g, " ");
    if (!/已跳过前两步/.test(text)) bad.push(`说明条没写"已跳过前两步"（实际：${text}）`);
    if (!/~\/\.ding/.test(text)) bad.push(`说明条没写凭据来自 ~/.ding（实际：${text}）`);
    note(`说明条：${text.slice(0, 90)}…`);
  }

  /* ② 前两步不是删除线（读 computed style，不信"看着不像"） */
  for (const index of [0, 1]) {
    const deco = await steps
      .nth(index)
      .locator(".wb-firstrun-title")
      .evaluate((el) => getComputedStyle(el).textDecorationLine);
    if (String(deco).includes("line-through")) bad.push(`第 ${index + 1} 步标题还是删除线（${deco}）—— 会被读成"作废"`);
  }
  note("前两步标题不是删除线 ✓");

  /* ⑤ 跳过的第 2 步要点名用的是哪一条 key */
  const skippedKey = ((await page.locator('[data-testid="wb-firstrun-key-skipped"]').innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
  if (!/STRATA_API_KEY/.test(skippedKey)) bad.push(`第 2 步没点名用的是哪条 key（实际：${skippedKey || "(空)"}）`);
  else note("第 2 步写清了用的是 STRATA_API_KEY ✓");

  /* ③「我要重新配一遍」→ 回到第 1 步 */
  await page.locator('[data-testid="wb-firstrun-restart"]').click();
  await sleep(600);
  if ((await steps.nth(0).getAttribute("data-active")) !== "true") bad.push("点「我要重新配一遍」没有回到第 1 步");
  else note("「我要重新配一遍」→ 第 1 步 ✓");
  if (!(await page.locator('[data-testid="wb-firstrun-provider"]').count())) bad.push("回到第 1 步后 provider 下拉不在");
  await page.screenshot({ path: ".verify/mset-09-firstrun-restart.png" });

  /* ① 重新选**有 key 的那一家**（strata）→ 下一步应跳过填 key，落到第 3 步 */
  const options = await page.locator('[data-testid="wb-firstrun-provider"] option').evaluateAll((els) =>
    els.map((e) => e.getAttribute("value")).filter(Boolean),
  );
  const withKey = options.includes("strata") ? "strata" : options[0];
  if (!withKey) bad.push("第 1 步的下拉里没有可选项");
  else {
    await page.locator('[data-testid="wb-firstrun-provider"]').selectOption(withKey);
    await page.locator('[data-testid="wb-firstrun-provider-next"]').click();
    await sleep(600);
    const stepNow = await steps.evaluateAll((els) => els.map((e) => e.getAttribute("data-active")));
    note(`选中 ${withKey} 之后各步 active：${stepNow.join(",")}`);
    if (stepNow[2] !== "true") bad.push(`选中已有 key 的那家之后没落到第 3 步（active=${stepNow.join(",")}）`);
  }

  /* ④ done 态的第 1 步可以点回（「换一家」） */
  const backProvider = page.locator('[data-testid="wb-firstrun-back-provider"]');
  if (await backProvider.count()) {
    await backProvider.click();
    await sleep(500);
    if ((await steps.nth(0).getAttribute("data-active")) !== "true") bad.push("第 1 步的「换一家」没把视图退回第 1 步");
    else note("第 1 步 done 态可回退（换一家）✓");
  } else bad.push("第 1 步完成后没有「换一家」入口（想改也改不了）");

  /* ④ 第 2 步也能回到填 key */
  await page.locator('[data-testid="wb-firstrun-provider"]').selectOption(withKey ?? "");
  await page.locator('[data-testid="wb-firstrun-provider-next"]').click();
  await sleep(600);
  const backKey = page.locator('[data-testid="wb-firstrun-back-key"]');
  if (await backKey.count()) {
    await backKey.click();
    await sleep(500);
    if (!(await page.locator('[data-testid="wb-firstrun-key"]').count())) bad.push("第 2 步的「重新填一条」没给出输入框");
    else note("第 2 步 done 态可回退到填 key ✓");
  } else bad.push("第 2 步被跳过之后没有「重新填一条」入口");

  await page.screenshot({ path: ".verify/mset-09-firstrun-explain.png" });
  note("截图：.verify/mset-09-firstrun-explain.png / mset-09-firstrun-restart.png");
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => undefined);
  await killTree(booted.child);
  await killLeftovers();
}

verdict(bad, "首跑跳步可解释可回退：说明条写清跳过原因与凭据来源 / 前两步不是删除线 / 两个回退入口都能到达输入");
