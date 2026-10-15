import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**图片动作条真的能改图**（§167，对应 `aiCreation_canvas_imageAction_*`）。
 *
 * ## 为什么必须真调模型
 *
 * 动作定义（标签 / 提示词 / 尺寸策略）有 20 条单测，但"**点一下真的改出一版新图**"
 * 只能真跑一次。这条走完完整一条链：
 *
 * ```
 * 生成一张图（图片生成页） → 动作条点「变清晰」 → 新图落进 assets/
 *                        → 云盘里能看到它（§166 那个来源）
 * ```
 *
 * ## 断言
 *
 * ① 生成成功后，"最近生成"里出现了这一张，且**动作条上有证据里那几个词**
 *    （抠图 / 变清晰 / 扩图 / 编辑 / 消除）
 * ② 点「变清晰」→ 出现**第二张**（新文件名，不是原来那张）
 * ③ ⭐ 新图**真的落在 `assets/` 里**（磁盘上多了一个文件）
 * ④ ⭐ 云盘里能看到**两张**（来源=素材）
 *
 * ⚠️ 会真调图像模型（生成 1 次 + 变清晰 1 次，约 1 分钟）。
 */
const DATA = ".verify/imageedit-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(path.join(DATA, "assets"), { recursive: true });

const PORT = 9318;
const { child, ok, getLog } = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

const assets = () => {
  const dir = path.join(DATA, "assets");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};

const out = {};
try {
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-add-image"]').click();
  await page.waitForTimeout(1500);

  /* ── 生成一张 ── */
  const prompt = "一张干净的纯色墙面照片，画面中央放一只白色马克杯，光线柔和";
  await page.locator('[data-testid="gen-prompt"]').fill(prompt);
  await page.locator('[data-testid="gen-run"]').click();

  const waitFor = async (n, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      if (assets().length >= n) return true;
    }
    return false;
  };
  out.firstOk = await waitFor(1, 120000);
  out.afterFirst = assets();
  out.itemCount1 = await page.locator('[data-testid^="wb-imagegen-item-"]').count();

  /* ── 动作条：标签逐字 ── */
  out.actionLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-imageaction-"]'))
      .filter((e) => !(e.getAttribute("data-testid") ?? "").slice("wb-imageaction-".length).startsWith("input"))
      .filter((e) => !(e.getAttribute("data-testid") ?? "").slice("wb-imageaction-".length).startsWith("go"))
      .map((e) => (e.textContent ?? "").trim()),
  );

  if (out.firstOk) {
    const firstName = out.afterFirst[0];
    /* ── 点「变清晰」 ── */
    await page
      .locator(`[data-testid="wb-imagegen-item-${firstName}"] [data-testid="wb-imageaction-enhance"]`)
      .click();
    out.secondOk = await waitFor(2, 120000);
    out.afterSecond = assets();
    out.itemCount2 = await page.locator('[data-testid^="wb-imagegen-item-"]').count();
    out.note = await page.evaluate(
      () => document.querySelector('[data-testid="wb-imagegen-note"]')?.textContent?.trim() ?? "",
    );
  }

  /* ── 两张图都留下了：看**生成图片页**的最近生成（2026-10-16：原来去云盘看，
        云盘整页拆了 —— 改看留下的那个入口，判据不变：还是"两张都在"） ── */
  await page.locator('[data-testid="wb-nav-image"]').click().catch(() => undefined);
  await page.waitForTimeout(2000);
  out.imagePageRecent = await page.evaluate(
    () => Array.from(document.querySelectorAll('[data-testid^="wb-imagegen-recent-"]')).map((e) => e.getAttribute("data-testid")),
  );
  out.shot = await shot(page, "imageedit.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.firstOk) bad.push(`第一次生成没落盘（assets：${JSON.stringify(out.afterFirst)}）`);
  if (out.itemCount1 !== 1) bad.push(`"最近生成"里应有 1 条，实际 ${out.itemCount1}`);

  /* ①② 动作条的词是证据里那几个 */
  for (const label of ["抠图", "变清晰", "扩图", "编辑", "消除"]) {
    if (!(out.actionLabels ?? []).includes(label)) {
      bad.push(`动作条里缺「${label}」：${JSON.stringify(out.actionLabels)}`);
    }
  }

  if (out.firstOk) {
    /* ③ 真的多出一个文件（不是把原来那张改名） */
    if (!out.secondOk) bad.push(`点了「变清晰」没有新图落盘（assets：${JSON.stringify(out.afterSecond)}）`);
    if ((out.afterSecond ?? []).length !== (out.afterFirst ?? []).length + 1) {
      bad.push(`点动作之后文件数没 +1：${JSON.stringify(out.afterSecond)}`);
    }
    if (out.itemCount2 !== 2) bad.push(`"最近生成"应有 2 条，实际 ${out.itemCount2}`);

    /* ④ 云盘里两张都在 */
    const rows = out.driveRows ?? [];
    if (rows.length !== 2) bad.push(`云盘里应有 2 张，实际 ${JSON.stringify(rows)}`);
    for (const name of out.afterSecond ?? []) {
      if (!rows.includes(name)) bad.push(`云盘里没有 ${name}`);
    }
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 图片动作条成立：点「变清晰」真的改出一版新图、落进 assets、云盘里两张都在");
  }
}
