import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, readStoreFile, waitForPage } from "./harness.mjs";

/**
 * 验收：**搜索历史**（§162，对应 `search_history` / `清空全部搜索记录`）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 七条断言：
 * ① 搜过一次（回车）→ 输入框清空后，历史那一段出现那个词
 * ② **新的在最前**
 * ③ 同一个词再搜一次 → **不重复一条**（挪到最前）
 * ④ 太短的词**不记**（搜过等于没搜）
 * ⑤ 点某条历史 → 填回输入框并真的筛（结果数变少）
 * ⑥ ⭐ **两处历史互不串**（技能的历史不该出现在云盘）
 * ⑦ ⭐ **重开还在**；「清空全部搜索记录」之后**重开也是空的**（真落盘）
 *
 * ⚠️ 第 ⑦ 条是本条最要紧的：搜索历史是"用户觉得它一直在"的东西 ——
 * §156 就是在类似的地方栽过（放 localStorage，强杀就丢）。
 */
const DATA = ".verify/history-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const DIR = path.join(DATA, "drive");
fs.mkdirSync(DIR, { recursive: true });
for (const n of ["销售看板.md", "会议纪要.md"]) fs.writeFileSync(path.join(DIR, n), "x", "utf8");

const PORT = 9313;
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

const page1 = async () => {
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  return { b, page };
};

/** 搜索历史里现在有哪些词（按显示顺序）。 */
const historyWords = (page, scope) =>
  page.evaluate(
    (s) =>
      Array.from(document.querySelectorAll(`[data-testid^="wb-history-${s}-"]`))
        .filter((e) => !(e.getAttribute("data-testid") ?? "").startsWith(`wb-history-${s}-forget-`))
        .filter((e) => (e.getAttribute("data-testid") ?? "") !== `wb-history-clear-${s}`)
        .map((e) => (e.textContent ?? "").trim()),
    scope,
  );

const readFile = () => {
  const f = path.join(DATA, "search-history.json");
  try {
    return readStoreFile(f);
  } catch {
    return null;
  }
};

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  let { b, page } = await page1();

  /* ── ① 技能搜索：搜一次 ── */
  await page.locator('[data-testid="wb-nav-plugins"]').click();
  await page.waitForTimeout(1200);
  await page.locator('[data-testid="wb-plugin-tab-技能"]').click();
  await page.waitForTimeout(700);
  out.stripBefore = (await page.locator('[data-testid="wb-history-skills"]').count()) > 0;

  await page.locator('[data-testid="wb-plugins-search"]').fill("个股");
  await page.locator('[data-testid="wb-plugins-search"]').press("Enter");
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-plugins-search"]').fill("");
  await page.waitForTimeout(600);
  out.wordsAfterFirst = await historyWords(page, "skills");
  out.sectionTitle = await page.evaluate(
    () => document.querySelector('[data-testid="wb-history-skills"] .wb-history-title')?.textContent?.trim() ?? "",
  );
  out.clearLabel = await page.evaluate(
    () => document.querySelector('[data-testid="wb-history-clear-skills"]')?.textContent?.trim() ?? "",
  );

  /* ── ② 再搜一个 → 新的在前；③ 重搜同一个 → 不重复 ── */
  await page.locator('[data-testid="wb-plugins-search"]').fill("估值");
  await page.locator('[data-testid="wb-plugins-search"]').press("Enter");
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-plugins-search"]').fill("个股");
  await page.locator('[data-testid="wb-plugins-search"]').press("Enter");
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-plugins-search"]').fill("");
  await page.waitForTimeout(600);
  out.wordsAfterRepeat = await historyWords(page, "skills");

  /* ── ④ 太短的词不记 ── */
  await page.locator('[data-testid="wb-plugins-search"]').fill("看");
  await page.locator('[data-testid="wb-plugins-search"]').press("Enter");
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-plugins-search"]').fill("");
  await page.waitForTimeout(600);
  out.wordsAfterShort = await historyWords(page, "skills");

  /* ── ⑤ 点历史 → 填回并真的筛 ── */
  await page.locator('[data-testid="wb-history-skills-估值"]').click();
  await page.waitForTimeout(700);
  out.pickedQuery = await page.locator('[data-testid="wb-plugins-search"]').inputValue();
  out.cardsAfterPick = await page.locator(".wb-plugin-grid > *").count();
  await page.locator('[data-testid="wb-plugins-search"]').fill("");
  await page.waitForTimeout(400);

  /* ⚠️ 2026-10-16：云盘整页拆了 —— 「云盘历史不串」这一截随之删掉（只剩技能这一处）。
     当年它挡的是真事：两个搜索框共用一份历史、互相串。现在只有一个搜索框，串不起来。
     ⚠️ 不过**重启前读一次磁盘快照**得留着（下面的 `diskBeforeRestart` 断言靠它）——
     那一截当时顺手兼职了这个，剪的时候容易一起剪掉。 */
  out.diskBeforeRestart = readFile();

  /* ── ⑦a 重开：历史还在 ── */
  await killTree(child);
  await new Promise((r) => setTimeout(r, 1500));
  if (!(await boot())) {
    out.error = "重启失败：" + (getLog() || "(空)").slice(-300);
  } else {
    ({ b, page } = await page1());
    await page.locator('[data-testid="wb-nav-plugins"]').click();
    await page.waitForTimeout(1200);
    await page.locator('[data-testid="wb-plugin-tab-技能"]').click();
    await page.waitForTimeout(800);
    out.wordsAfterRestart = await historyWords(page, "skills");

    /*
     * ── ⑦a2 单条删除（2026-10-13 补）──
     *
     * ⚠️ `wb-history-forget-*`（每条历史右边那个 ×）**原来没有任何脚本点过**
     * （`src/` × `scripts/accept/` 交叉，见 HANDOFF §208 的零覆盖清单）。
     * 下面验的「清空全部」是另一条路 —— 断**后果**：点掉一个词之后
     * **它没了、另一个还在**，且磁盘同步（不是只改内存）。
     */
    out.wordsBeforeForget = out.wordsAfterRestart;
    out.forgetTarget = (out.wordsAfterRestart ?? []).includes("个股")
      ? "个股"
      : ((out.wordsAfterRestart ?? [])[0] ?? "");
    if (out.forgetTarget) {
      await page.locator(`[data-testid="wb-history-forget-skills-${out.forgetTarget}"]`).click();
      await page.waitForTimeout(800);
    }
    out.wordsAfterForget = await historyWords(page, "skills");
    out.diskAfterForget = readFile();

    /* ── ⑦b 清空全部 → 重开也是空的 ── */
    await page.locator('[data-testid="wb-history-clear-skills"]').click();
    await page.waitForTimeout(800);
    out.stripAfterClear = (await page.locator('[data-testid="wb-history-skills"]').count()) > 0;
    out.diskAfterClear = readFile();
    await b.close();

    await killTree(child);
    await new Promise((r) => setTimeout(r, 1500));
    if (!(await boot())) {
      out.error = (out.error ?? "") + " 二次重启失败";
    } else {
      ({ b, page } = await page1());
      await page.locator('[data-testid="wb-nav-plugins"]').click();
      await page.waitForTimeout(1200);
      await page.locator('[data-testid="wb-plugin-tab-技能"]').click();
      await page.waitForTimeout(800);
      out.stripAfterRestartClear = (await page.locator('[data-testid="wb-history-skills"]').count()) > 0;
      await b.close();
    }
  }
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (out.stripBefore) bad.push("一开始就有历史（前置条件不干净）");
  if (JSON.stringify(out.wordsAfterFirst) !== JSON.stringify(["个股"])) {
    bad.push(`第一次搜索后历史不对：${JSON.stringify(out.wordsAfterFirst)}`);
  }
  if (out.sectionTitle !== "搜索历史") bad.push(`历史段落的标题不对：${out.sectionTitle}`);
  if (out.clearLabel !== "清空全部搜索记录") bad.push(`清空按钮文案不对：${out.clearLabel}`);

  if (JSON.stringify(out.wordsAfterRepeat) !== JSON.stringify(["个股", "估值"])) {
    bad.push(`重搜后的顺序/去重不对：${JSON.stringify(out.wordsAfterRepeat)}`);
  }
  if (JSON.stringify(out.wordsAfterShort) !== JSON.stringify(["个股", "估值"])) {
    bad.push(`太短的词被记进去了：${JSON.stringify(out.wordsAfterShort)}`);
  }

  if (out.pickedQuery !== "估值") bad.push(`点历史没填回输入框：${out.pickedQuery}`);
  if (!(out.cardsAfterPick < 9)) bad.push(`点历史之后没有真的筛（卡片数 ${out.cardsAfterPick}）`);

  /* ⚠️ 2026-10-16：云盘整页拆了 —— 「两处历史不串」这三条随之删掉（只剩技能这一处）。
     当年它挡的是真事：两个搜索框共用一份历史、互相串。现在只有一个搜索框，串不起来。 */
  if (!out.diskBeforeRestart?.skills?.includes("个股")) bad.push("历史没落到磁盘");

  if (JSON.stringify(out.wordsAfterRestart) !== JSON.stringify(["个股", "估值"])) {
    bad.push(`⭐ 重开后历史丢了：${JSON.stringify(out.wordsAfterRestart)}`);
  }

  /* 补的那条（零覆盖清单里的单条删除 `wb-history-forget-*`，§208） */
  if (!out.forgetTarget) bad.push("重开后没有可删的历史词（单条删除没验成）");
  else {
    if ((out.wordsAfterForget ?? []).includes(out.forgetTarget)) {
      bad.push(`点了 × 之后那个词还在：${JSON.stringify(out.wordsAfterForget)}`);
    }
    if ((out.wordsAfterForget ?? []).length !== (out.wordsBeforeForget ?? []).length - 1) {
      bad.push(`单条删除应只少一条：${JSON.stringify(out.wordsBeforeForget)} → ${JSON.stringify(out.wordsAfterForget)}`);
    }
    if ((out.diskAfterForget?.skills ?? []).includes(out.forgetTarget)) {
      bad.push(`⭐ 单条删除没落到磁盘：${JSON.stringify(out.diskAfterForget?.skills)}`);
    }
  }
  if (out.stripAfterClear) bad.push("点了清空之后历史条还在");
  if ((out.diskAfterClear?.skills ?? ["x"]).length !== 0) bad.push("清空没落到磁盘");
  if (out.stripAfterRestartClear) bad.push("⭐ 清空后重开又出现了（没真落盘）");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 搜索历史成立：记一次 / 新的在前 / 去重 / 太短不记 / 点回填并筛 / 单条删除 / 落盘且清空也落盘");
  }
}
