import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**两处搜索**（§160）—— 技能搜索 + 云盘搜索。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 六条断言：
 * ① 两处输入框的占位就是证据里那两句（搜索技能 / 搜索文件）
 * ② 技能搜索：搜一个真存在的技能 → 卡片数变少，且**命中的那个在**
 * ③ 技能搜索搜不到 → **无匹配的技能**
 * ④ 云盘搜索：搜一个真存在的文件 → 只剩它
 * ⑤ 云盘搜索搜不到 → **未搜索到匹配的文件**
 * ⑥ 清空之后两边都**回到原样**（搜索不能把事情搞丢）
 */
const DATA = "D:/DoubaoWorkClone/.verify/search-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const DIR = path.join(DATA, "drive");
fs.mkdirSync(DIR, { recursive: true });
for (const n of ["销售看板.md", "会议纪要.md", "季报.md"]) fs.writeFileSync(path.join(DIR, n), "x", "utf8");

const PORT = 9310;
const out = {};
let child = null;
let ok = false;
let getLog = () => "";

const boot = async () => {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = r.child;
  ok = r.ok;
  getLog = r.getLog;
  return ok;
};

const cards = (page) => page.locator(".wb-plugin-grid > *").count();
const rows = (page) => page.locator(".wb-tr:not(.wb-th)").count();

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* ── ① 技能页 ── */
  await page.locator('[data-testid="wb-nav-plugins"]').click();
  await page.waitForTimeout(1200);
  await page.locator('[data-testid="wb-plugin-tab-技能"]').click();
  await page.waitForTimeout(800);
  out.skillPlaceholder = await page.evaluate(
    () => document.querySelector('[data-testid="wb-plugins-search"]')?.getAttribute("placeholder") ?? "",
  );
  out.skillCardsBefore = await cards(page);

  /* ── ② 搜一个真存在的技能 ── */
  await page.locator('[data-testid="wb-plugins-search"]').fill("个股研究");
  await page.waitForTimeout(700);
  out.skillCardsAfter = await cards(page);
  out.skillHitVisible = await page.evaluate(
    () => document.body.textContent?.includes("个股研究") ?? false,
  );

  /* ── ③ 搜不到 ── */
  await page.locator('[data-testid="wb-plugins-search"]').fill("zzz不存在的技能");
  await page.waitForTimeout(700);
  out.skillEmpty = await page.evaluate(
    () => document.querySelector('[data-testid="wb-plugins-empty"]')?.textContent?.trim() ?? "",
  );
  out.skillCardsEmpty = await cards(page);

  /* 清空回到原样 */
  await page.locator('[data-testid="wb-plugins-search"]').fill("");
  await page.waitForTimeout(700);
  out.skillCardsRestored = await cards(page);
  out.skillEmptyGone = (await page.locator('[data-testid="wb-plugins-empty"]').count()) === 0;

  /* ── ④ 云盘搜索 ── */
  await page.locator('[data-testid="wb-nav-cloud"]').click();
  await page.waitForTimeout(1800);
  out.filePlaceholder = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-search"]')?.getAttribute("placeholder") ?? "",
  );
  out.rowsBefore = await rows(page);
  await page.locator('[data-testid="wb-cloud-search"]').fill("看板");
  await page.waitForTimeout(800);
  out.rowsAfter = await rows(page);
  out.hitNames = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-file-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("wb-file-", ""),
    ),
  );

  /* ── ⑤ 搜不到 ── */
  await page.locator('[data-testid="wb-cloud-search"]').fill("zzz不存在");
  await page.waitForTimeout(800);
  out.fileEmpty = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-empty"]')?.textContent?.trim() ?? "",
  );

  /* ── ⑥ 清空回到原样 ── */
  await page.locator('[data-testid="wb-cloud-search"]').fill("");
  await page.waitForTimeout(800);
  out.rowsRestored = await rows(page);
  out.shot = await shot(page, "search.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (out.skillPlaceholder !== "搜索技能") bad.push(`技能搜索占位与证据不符：${out.skillPlaceholder}`);
  if (out.filePlaceholder !== "搜索文件") bad.push(`云盘搜索占位与证据不符：${out.filePlaceholder}`);

  if (!(out.skillCardsBefore > 0)) bad.push("技能页一开始就没有卡片");
  if (!(out.skillCardsAfter < out.skillCardsBefore)) {
    bad.push(`搜技能后卡片数没变少：${out.skillCardsBefore} → ${out.skillCardsAfter}`);
  }
  if (!out.skillHitVisible) bad.push("命中的技能没显示出来");

  if (out.skillEmpty !== "无匹配的技能") bad.push(`搜不到技能时的提示不对：${out.skillEmpty}`);
  if (out.skillCardsEmpty !== 0) bad.push(`搜不到时还有卡片：${out.skillCardsEmpty}`);

  if (out.skillCardsRestored !== out.skillCardsBefore) {
    bad.push(`清空技能搜索后没回到原样：${out.skillCardsRestored} vs ${out.skillCardsBefore}`);
  }
  if (!out.skillEmptyGone) bad.push("清空之后空态提示还在");

  if (!(out.rowsBefore > 0)) bad.push("云盘一开始就没有文件");
  if (out.rowsAfter !== 1) bad.push(`云盘搜「看板」应只剩 1 行，实际 ${out.rowsAfter}`);
  if (JSON.stringify(out.hitNames) !== JSON.stringify(["销售看板.md"])) {
    bad.push(`云盘搜索命中不对：${JSON.stringify(out.hitNames)}`);
  }
  if (out.fileEmpty !== "未搜索到匹配的文件") bad.push(`云盘搜不到时的提示不对：${out.fileEmpty}`);
  if (out.rowsRestored !== out.rowsBefore) {
    bad.push(`清空云盘搜索后没回到原样：${out.rowsRestored} vs ${out.rowsBefore}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 两处搜索成立：占位逐字 / 筛得对 / 搜不到有明确提示 / 清空能回到原样");
  }
}
