import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, freshDir, killTree, readStoreFile, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**设置里新增的「通用」与「关于」两页**（§182）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 重点是"**每个开关都有真效果**"：
 * ① 设置列表里「通用」那行直接显示记忆状态（不用点进去）
 * ② 通用页：分类文案逐字（设置分类）、记忆显示**已开启**
 * ③ ⭐ 点一下记忆 → **已关闭**，且 `memory.json` 里真的写了 `enabled: false`
 * ④ ⭐ **重启之后仍然是已关闭**（开关要活过重启，否则就是摆设）
 * ⑤ ⭐ 点「开启新话题」→ 真的回到新工作任务的空状态
 * ⑥ 关于页：标题 `关于豆包工作`、用户协议、官网链接在
 */
const DATA = "D:/DoubaoWorkClone/.verify/settings2-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9334;
const out = {};
let child = null;

const boot = async () => bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });

const openSettings = async (page) => {
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);
};

const openRow = async (page, label) => {
  await page.locator(`[data-testid="wb-set-${label}"]`).click();
  await page.waitForTimeout(700);
};

const txt = (page, sel) =>
  page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? "", sel);

try {
  /* ── 第一次启动 ── */
  const first = await boot();
  child = first.child;
  if (!first.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (first.getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b1 = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b1);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await openSettings(page);

  /* ① 列表里那行 */
  out.generalRow = await txt(page, '[data-testid="wb-set-通用"]');
  out.aboutRowCount = await page.locator('[data-testid="wb-set-关于"]').count();

  /* ② 通用页 */
  await openRow(page, "通用");
  out.onGeneral = (await page.locator('[data-testid="wb-setpage-general-body"]').count()) > 0;
  out.navigation = await txt(page, ".wb-setpage-body .wb-setpage-label");
  out.memoryBefore = await txt(page, '[data-testid="wb-setpage-memory"]');
  out.navText = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-setpage-row .wb-setpage-label")).map((e) => (e.textContent ?? "").trim()),
  );

  /* ③ 关掉记忆 */
  await page.locator('[data-testid="wb-setpage-memory"]').click();
  await page.waitForTimeout(900);
  out.memoryAfter = await txt(page, '[data-testid="wb-setpage-memory"]');
  const mem = path.join(DATA, "memory.json");
  out.diskEnabled = fs.existsSync(mem) ? readStoreFile(mem)?.enabled : "（没有文件）";

  /* ⑤ 开启新话题 */
  await page.locator('[data-testid="wb-setpage-newtopic"]').click();
  await page.waitForTimeout(1000);
  out.afterNewTopic = {
    settingsClosed: (await page.locator('[data-testid="wb-settings"]').count()) === 0,
    composer: (await page.locator('[data-testid="wb-composer-input"]').count()) > 0,
  };
  out.shot = await shot(page, "settings2.png");

  await b1.close();
  await killTree(first.child);
  child = null;

  /* ── 重启（④） ── */
  await new Promise((r) => setTimeout(r, 1500));
  const second = await boot();
  child = second.child;
  if (!second.ok) {
    console.error("[诊断] 第二次启动失败：\n" + (second.getLog() || "(空)").slice(-800));
    await killTree(child);
    process.exit(1);
  }
  const b2 = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page2 = await waitForPage(b2);
  if (!page2) throw new Error(NO_PAGE_HINT);
  await page2.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await openSettings(page2);
  out.generalRowAfterRestart = await txt(page2, '[data-testid="wb-set-通用"]');
  await openRow(page2, "通用");
  out.memoryAfterRestart = await txt(page2, '[data-testid="wb-setpage-memory"]');

  /* ⑥ 关于页 */
  await page2.locator('[data-testid="wb-setpage-back"]').click();
  await page2.waitForTimeout(500);
  await openRow(page2, "关于");
  out.aboutTitle = await page2.evaluate(
    () => document.querySelector(".wb-setpage-head span")?.textContent?.trim() ?? "",
  );
  out.aboutRows = await page2.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-setpage-row .wb-setpage-label")).map((e) => (e.textContent ?? "").trim()),
  );
  out.aboutHasLink = (await page2.locator('[data-testid="wb-setpage-about-body"] a').count()) > 0;

  await b2.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ① */
  if (!(out.generalRow ?? "").includes("记忆")) bad.push(`「通用」那行没显示记忆状态：${out.generalRow}`);
  if (!(out.generalRow ?? "").includes("已开启")) bad.push(`初始状态应当是「已开启」：${out.generalRow}`);
  if (out.aboutRowCount !== 1) bad.push("设置列表里没有「关于」");

  /* ② */
  if (!out.onGeneral) bad.push("「通用」页没打开");
  if (out.navigation !== "设置分类") bad.push(`分类文案与证据不符：${out.navigation}`);
  if (!(out.navText ?? []).includes("记忆")) bad.push(`通用页里没有「记忆」：${JSON.stringify(out.navText)}`);
  if (!(out.navText ?? []).includes("开启新话题")) bad.push(`通用页里没有「开启新话题」：${JSON.stringify(out.navText)}`);
  if (out.memoryBefore !== "已开启") bad.push(`记忆初始文案不对：${out.memoryBefore}`);

  /* ③ */
  if (out.memoryAfter !== "已关闭") bad.push(`点了开关文案没变：${out.memoryAfter}`);
  if (out.diskEnabled !== false) bad.push(`⭐ 开关没落盘：memory.json 里 enabled = ${JSON.stringify(out.diskEnabled)}`);

  /* ④ */
  if (out.memoryAfterRestart !== "已关闭") bad.push(`⭐ 重启之后开关自己开回来了：${out.memoryAfterRestart}`);
  if (!(out.generalRowAfterRestart ?? "").includes("已关闭")) {
    bad.push(`重启之后列表那行还显示着开启：${out.generalRowAfterRestart}`);
  }

  /* ⑤ */
  if (!out.afterNewTopic?.settingsClosed) bad.push("点「开启新话题」之后设置窗口没关");
  if (!out.afterNewTopic?.composer) bad.push("点「开启新话题」之后没回到新工作任务");

  /* ⑥ */
  if (out.aboutTitle !== "关于豆包工作") bad.push(`关于页标题不对：${out.aboutTitle}`);
  if (!(out.aboutRows ?? []).includes("用户协议")) bad.push(`关于页没有「用户协议」：${JSON.stringify(out.aboutRows)}`);
  if (!out.aboutHasLink) bad.push("关于页没有官网链接");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 设置通用/关于成立：分类逐字 / 记忆开关有真效果且落盘并活过重启 / 开启新话题真回到新任务 / 关于页齐");
  }
}
