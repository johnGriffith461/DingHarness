import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**两处搜索**（§160）—— 技能搜索 + 云盘搜索。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 十条断言：
 * ① 两处输入框的占位就是证据里那两句（搜索技能 / 搜索文件）
 * ② 技能搜索：搜一个真存在的技能 → 卡片数变少，且**命中的那个在**
 * ③ 技能搜索搜不到 → **无匹配的技能**
 * ④ 云盘搜索：搜一个真存在的文件 → 只剩它
 * ⑤ 云盘搜索搜不到 → **未搜索到匹配的文件**
 * ⑥ 清空之后两边都**回到原样**（搜索不能把事情搞丢）
 *
 * —— 下面四条是 2026-10-14 补的。审计（`docs/UI-做工体检.md` §3.12）把这三件事
 * 标成**功能**而不是样式：输入框里没有 ×、空态不给出路、不知道筛掉了几条。
 * ⑦ **清除 ×** 真的把搜索清掉（不是只画了一颗按钮）
 * ⑧ **命中 N 条** 和**真渲染出来的行/卡片数**对得上（不然那个数字就是编的）
 * ⑨ 空态的**「清除筛选」真的能清**（不是一句安慰话）
 * ⑩ 清空之后**不许往搜索历史里塞一条空的**（清空不算搜过）
 *
 * ⚠️ ⑦⑧ 里那个"多命中"用例是**故意的**：只搜出一个结果时，
 * "命中了 N 条"和"命中了 N 个分类"是同一个数，谁写错了都看不出来 ——
 * 第一版就是拿「个股研究」（1 组 1 条）验的，把命中数改成"分组数"照样绿。
 * 现在换成「分析」（1 组 2 条）与「销售」（2 行）。
 */
const DATA = ".verify/search-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const DIR = path.join(DATA, "drive");
fs.mkdirSync(DIR, { recursive: true });
for (const n of ["销售看板.md", "销售周报.md", "会议纪要.md", "季报.md"]) {
  fs.writeFileSync(path.join(DIR, n), "x", "utf8");
}

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

  /* ── ②a 命中数（⑧） ── */
  out.skillHits = await page.evaluate(
    () => document.querySelector('[data-testid="wb-plugins-hits"]')?.textContent?.trim() ?? "(没有命中数)",
  );
  /* 数字必须等于**真渲染出来的卡片数** —— 只断言"有这几个字"等于没断言 */
  out.skillHitsMatch = out.skillHits === `命中 ${out.skillCardsAfter} 条`;

  /* ── ②b 清除 ×（⑦） ── */
  out.skillClearBtn = await page.locator('[data-testid="wb-plugins-search-clear"]').count();
  await page.locator('[data-testid="wb-plugins-search-clear"]').click();
  await page.waitForTimeout(700);
  out.skillQueryAfterClear = await page.evaluate(
    () => document.querySelector('[data-testid="wb-plugins-search"]')?.value ?? "(没找到输入框)",
  );
  out.skillCardsAfterClear = await cards(page);
  out.skillHitsGone = (await page.locator('[data-testid="wb-plugins-hits"]').count()) === 0;

  /* ── ②c 多命中（⑧ 的真考验）：一组里 2 条 → 命中数必须是 2，不是分组数 1 ── */
  await page.locator('[data-testid="wb-plugins-search"]').fill("分析");
  await page.waitForTimeout(700);
  out.skillMultiCards = await cards(page);
  out.skillMultiHits = await page.evaluate(
    () => document.querySelector('[data-testid="wb-plugins-hits"]')?.textContent?.trim() ?? "(没有命中数)",
  );
  out.skillMultiMatch = out.skillMultiHits === `命中 ${out.skillMultiCards} 条`;
  await page.locator('[data-testid="wb-plugins-search-clear"]').click();
  await page.waitForTimeout(700);

  /* ── ③ 搜不到 ── */
  await page.locator('[data-testid="wb-plugins-search"]').fill("zzz不存在的技能");
  await page.waitForTimeout(700);
  /* ⚠️ 只读那句话（`p`）：空态里现在还挂着一颗「清除筛选」的按钮，
     `textContent` 会把按钮上的字也拼进来 —— 那样这条断言就变成"改按钮文案就红"。 */
  out.skillEmpty = await page.evaluate(
    () => document.querySelector('[data-testid="wb-plugins-empty"] p')?.textContent?.trim() ?? "",
  );
  out.skillCardsEmpty = await cards(page);

  /* ── ③b 空态给出路（⑨）：清空走**那颗按钮**，不是自己把字删掉 ── */
  out.skillEmptyAction = await page.locator('[data-testid="wb-plugins-empty-clear"]').count();
  await page.locator('[data-testid="wb-plugins-empty-clear"]').click();
  await page.waitForTimeout(700);
  out.skillCardsRestored = await cards(page);
  out.skillEmptyGone = (await page.locator('[data-testid="wb-plugins-empty"]').count()) === 0;
  out.skillQueryAfterEmptyClear = await page.evaluate(
    () => document.querySelector('[data-testid="wb-plugins-search"]')?.value ?? "(没找到输入框)",
  );
  /* ⑩ 清空**不算搜过**：历史条里不该出现空词条 */
  out.skillHistoryWords = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-history-word")).map((e) => (e.textContent ?? "").trim()),
  );

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

  /* ── ④a 命中数（⑧） ── */
  out.cloudHits = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-hits"]')?.textContent?.trim() ?? "(没有命中数)",
  );
  out.cloudHitsMatch = out.cloudHits === `命中 ${out.rowsAfter} 条`;

  /* ── ④b 清除 ×（⑦） ── */
  await page.locator('[data-testid="wb-cloud-search-clear"]').click();
  await page.waitForTimeout(800);
  out.rowsAfterClear = await rows(page);
  out.fileQueryAfterClear = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-search"]')?.value ?? "(没找到输入框)",
  );

  /* ── ④c 多命中（⑧ 的真考验）：两行都要算进去 ── */
  await page.locator('[data-testid="wb-cloud-search"]').fill("销售");
  await page.waitForTimeout(800);
  out.cloudMultiRows = await rows(page);
  out.cloudMultiHits = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-hits"]')?.textContent?.trim() ?? "(没有命中数)",
  );
  out.cloudMultiMatch = out.cloudMultiHits === `命中 ${out.cloudMultiRows} 条`;

  /* ── ⑤ 搜不到 ── */
  await page.locator('[data-testid="wb-cloud-search"]').fill("zzz不存在");
  await page.waitForTimeout(800);
  /* 同上：云盘空态也有「清除筛选」了，只读那句话 */
  out.fileEmpty = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-empty"] p')?.textContent?.trim() ?? "",
  );

  /* ── ⑤b 空态给出路（⑨） ── */
  out.cloudEmptyAction = await page.locator('[data-testid="wb-cloud-empty-clear"]').count();

  /* ── ⑥ 清空回到原样：走那颗按钮 ── */
  await page.locator('[data-testid="wb-cloud-empty-clear"]').click();
  await page.waitForTimeout(800);
  out.rowsRestored = await rows(page);
  out.fileQueryAfterEmptyClear = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-search"]')?.value ?? "(没找到输入框)",
  );
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

  /* ⑦⑧：清除 × 与命中数 */
  if (!(out.skillCardsAfter > 0)) bad.push("搜技能之后一张卡都没有，命中数没法验");
  if (!out.skillHitsMatch) {
    bad.push(`技能命中数与卡片数不符：${out.skillHits} vs ${out.skillCardsAfter} 张`);
  }
  if (out.skillClearBtn !== 1) bad.push(`技能搜索框里没有清除 ×（${out.skillClearBtn} 个）`);
  if (out.skillQueryAfterClear !== "") bad.push(`点 × 之后搜索框没清空：「${out.skillQueryAfterClear}」`);
  if (out.skillCardsAfterClear !== out.skillCardsBefore) {
    bad.push(`点 × 之后技能卡片没回到原样：${out.skillCardsAfterClear} vs ${out.skillCardsBefore}`);
  }
  if (!out.skillHitsGone) bad.push("清空之后命中数还挂在那儿");
  if (!(out.skillMultiCards >= 2)) {
    bad.push(`技能多命中用例只搜出 ${out.skillMultiCards} 条 —— 少于 2 条就验不出"数错了一个维度"`);
  }
  if (!out.skillMultiMatch) {
    bad.push(`技能多命中时命中数不对：${out.skillMultiHits} vs ${out.skillMultiCards} 张`);
  }

  /* ⑨：空态给出路 */
  if (out.skillEmptyAction !== 1) bad.push(`技能搜不到时没给「清除筛选」的出路（${out.skillEmptyAction} 个）`);
  if (out.skillQueryAfterEmptyClear !== "") {
    bad.push(`点了技能「清除筛选」搜索框还是：「${out.skillQueryAfterEmptyClear}」`);
  }
  if (out.skillCardsRestored !== out.skillCardsBefore) {
    bad.push(`清空技能搜索后没回到原样：${out.skillCardsRestored} vs ${out.skillCardsBefore}`);
  }
  if (!out.skillEmptyGone) bad.push("清空之后空态提示还在");
  /* ⑩：清空不算搜过（历史里不许出现空词条） */
  if ((out.skillHistoryWords ?? []).some((w) => w === "")) {
    bad.push(`搜索历史里出现了空词条：${JSON.stringify(out.skillHistoryWords)}`);
  }

  if (!(out.rowsBefore > 0)) bad.push("云盘一开始就没有文件");
  if (out.rowsAfter !== 1) bad.push(`云盘搜「看板」应只剩 1 行，实际 ${out.rowsAfter}`);
  if (JSON.stringify(out.hitNames) !== JSON.stringify(["销售看板.md"])) {
    bad.push(`云盘搜索命中不对：${JSON.stringify(out.hitNames)}`);
  }
  if (out.fileEmpty !== "未搜索到匹配的文件") bad.push(`云盘搜不到时的提示不对：${out.fileEmpty}`);
  if (!out.cloudHitsMatch) bad.push(`云盘命中数与行数不符：${out.cloudHits} vs ${out.rowsAfter} 行`);
  if (out.rowsAfterClear !== out.rowsBefore) {
    bad.push(`点云盘 × 之后没回到原样：${out.rowsAfterClear} vs ${out.rowsBefore}`);
  }
  if (out.fileQueryAfterClear !== "") bad.push(`点云盘 × 之后搜索框没清空：「${out.fileQueryAfterClear}」`);
  if (!(out.cloudMultiRows >= 2)) {
    bad.push(`云盘多命中用例只剩 ${out.cloudMultiRows} 行 —— 少于 2 行验不出命中数`);
  }
  if (!out.cloudMultiMatch) {
    bad.push(`云盘多命中时命中数不对：${out.cloudMultiHits} vs ${out.cloudMultiRows} 行`);
  }

  if (out.cloudEmptyAction !== 1) bad.push(`云盘搜不到时没给「清除筛选」的出路（${out.cloudEmptyAction} 个）`);
  if (out.fileQueryAfterEmptyClear !== "") {
    bad.push(`点了云盘「清除筛选」搜索框还是：「${out.fileQueryAfterEmptyClear}」`);
  }
  if (out.rowsRestored !== out.rowsBefore) {
    bad.push(`清空云盘搜索后没回到原样：${out.rowsRestored} vs ${out.rowsBefore}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log(
      "✓ 两处搜索成立：占位逐字 / 筛得对 / 命中数与渲染一致 / 清除 × 与空态出路都真管用 / 清空能回到原样",
    );
  }
}
