import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, shot } from "./harness.mjs";

/**
 * 验收：**创作广场**（§159，对应 `chat/coding`）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 七条断言：
 * ① 入口（输入区 `+` → 创作广场）真能进
 * ② 「应用」= 我产出的**网页**产物（`.md` 不算）
 * ③ 搜索：命中给「找到 N 个应用」，不命中给「暂未搜索到匹配的应用」
 * ④ **分类**筛得对（名称猜类目：看板→数据看板、贪吃蛇→游戏娱乐）
 * ⑤ **时间范围**真的按天数切
 * ⑥ Top 应用排行在，**且口径写在界面上**（本机版按最近更新，不假装是热度）
 * ⑦ **创作同款**：把一句话**交到主输入区**（切回首页且输入框里就是那句话）
 *
 * ⚠️ **不点「预览应用」**：那是用系统默认程序打开（会真的拉起浏览器）。
 * 只断言按钮在 —— 点它会污染这台机器，而这件事不该由验收来做。
 */
const DATA = ".verify/coding-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const ARTIFACTS = path.join(DATA, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });

/* 三个产物：两个网页（应用）+ 一个 Markdown（不是应用） */
fs.writeFileSync(path.join(ARTIFACTS, "销售看板.html"), "<html><body>看板</body></html>", "utf8");
fs.writeFileSync(path.join(ARTIFACTS, "贪吃蛇小游戏.html"), "<html><body>game</body></html>", "utf8");
fs.writeFileSync(path.join(ARTIFACTS, "会议笔记.md"), "# 笔记\n", "utf8");
/* 一个"很久没更新"的应用：验时间范围真的在切（改 mtime 是这台机器上唯一能造出"旧文件"的办法） */
const OLD = path.join(ARTIFACTS, "老官网.html");
fs.writeFileSync(OLD, "<html><body>old</body></html>", "utf8");
const longAgo = new Date(Date.now() - 100 * 24 * 3600 * 1000);
fs.utimesSync(OLD, longAgo, longAgo);

const PORT = 9309;
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

const appNames = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-coding-app-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("wb-coding-app-", ""),
    ),
  );

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const ctx = b.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* ── ① 入口 ── */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  out.menuHasCoding = await page.evaluate(
    () => document.querySelector('[data-testid="wb-add-pop"]')?.textContent?.includes("创作广场") ?? false,
  );
  await page.locator('[data-testid="wb-add-coding"]').click();
  await page.waitForTimeout(1500);
  out.opened = (await page.locator('[data-testid="wb-coding"]').count()) > 0;
  out.title = await page.evaluate(
    () => document.querySelector(".wb-coding-head h2")?.textContent?.trim() ?? "",
  );

  /* ── ② 只收网页产物 ── */
  out.result = await page.evaluate(
    () => document.querySelector('[data-testid="wb-coding-result"]')?.textContent?.trim() ?? "",
  );
  out.allApps = await appNames(page);
  out.categoryOptions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-coding-category"] option')).map((e) =>
      (e.textContent ?? "").trim(),
    ),
  );
  out.safeTips = await page.evaluate(
    () => document.querySelector('[data-testid="wb-coding-safetips"]')?.textContent?.trim() ?? "",
  );

  /* ── ④ 分类筛 ── */
  await page.locator('[data-testid="wb-coding-category"]').selectOption("游戏娱乐");
  await page.waitForTimeout(700);
  out.gameApps = await appNames(page);
  await page.locator('[data-testid="wb-coding-category"]').selectOption("all");
  await page.waitForTimeout(500);

  /* ── ③ 搜索 ── */
  await page.locator('[data-testid="wb-coding-search"]').fill("看板");
  await page.waitForTimeout(700);
  out.searchHit = await appNames(page);
  out.searchHitLabel = await page.evaluate(
    () => document.querySelector('[data-testid="wb-coding-result"]')?.textContent?.trim() ?? "",
  );
  await page.locator('[data-testid="wb-coding-search"]').fill("不存在的应用名");
  await page.waitForTimeout(700);
  out.searchMissLabel = await page.evaluate(
    () => document.querySelector('[data-testid="wb-coding-result"]')?.textContent?.trim() ?? "",
  );
  out.searchMissEmpty = await page.evaluate(
    () => document.querySelector('[data-testid="wb-coding-empty"]')?.textContent?.trim() ?? "",
  );
  await page.locator('[data-testid="wb-coding-search"]').fill("");
  await page.waitForTimeout(500);

  /* ── ⑤ 时间范围真的在切 ── */
  out.daysOptions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-coding-days"] option')).map((e) =>
      (e.textContent ?? "").trim(),
    ),
  );
  await page.locator('[data-testid="wb-coding-days"]').selectOption("7");
  await page.waitForTimeout(700);
  out.recentApps = await appNames(page);
  await page.locator('[data-testid="wb-coding-days"]').selectOption("0");
  await page.waitForTimeout(700);
  out.allDaysApps = await appNames(page);

  /* ── ⑥ 排行与口径 ── */
  out.topRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-coding-rank-name")).map((e) => (e.textContent ?? "").trim()),
  );
  out.topNote = await page.evaluate(
    () => document.querySelector('[data-testid="wb-coding-top-note"]')?.textContent?.trim() ?? "",
  );

  /*
   * ── ⑧ 卡片/排行的容器与按钮（2026-10-13 补）──
   *
   * ⚠️ 这一组 testid **原来一个都没被任何脚本引用过**（`src/` 的 `data-testid`
   * 与 `scripts/accept/` 交叉，见 HANDOFF §208 那份零覆盖清单）。
   * 同一个类里出过事：技能面板被挤成 59px（中文一字一行）没人知道 —— 因为没人点过它（§201）。
   *
   * 所以这里断的是**后果**，不是"点了没报错"：
   *   · 「创作应用」是**真能点**的入口（不是 disabled 的假按钮）；
   *   · 网格容器在（有应用时）；**不是**错误态（`wb-coding-note` 是读取失败的告警）；
   *   · 每张卡上「预览应用」在，且**网格宽度没有被挤塌**（阈值取得保守：>200px）。
   * ⚠️ **不点「预览应用」** —— 那是系统默认程序打开（会真拉起浏览器），
   *    与文件头那条"不点预览"的理由一致。
   */
  out.createBtn = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="wb-coding-create"]');
    return e ? { text: (e.textContent ?? "").trim(), disabled: e.hasAttribute("disabled") } : null;
  });
  out.gridCount = await page.locator('[data-testid="wb-coding-grid"]').count();
  out.gridWidth = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="wb-coding-grid"]');
    return e ? Math.round(e.getBoundingClientRect().width) : null;
  });
  out.previewButtons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-coding-preview-"]')).map((e) => ({
      id: e.getAttribute("data-testid"),
      text: (e.textContent ?? "").trim(),
    })),
  );
  out.rankOpenButtons = await page.locator('[data-testid^="wb-coding-open-"]').count();
  /* 读取成功时**不该**有告警（它是"读不到产物目录"那条路的），这里断"没有" */
  out.readNote = await page.locator('[data-testid="wb-coding-note"]').count();

  /* ── ⑦ 创作同款 → 交到主输入区 ── */
  await page.locator('[data-testid="wb-coding-remix-销售看板"]').click();
  await page.waitForTimeout(1200);
  out.backHome = (await page.locator('[data-testid="wb-composer"]').count()) > 0;
  out.composerText = await page.locator('[data-testid="wb-composer-input"]').inputValue();
  out.shot = await shot(page, "coding.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.menuHasCoding) bad.push("+ 菜单里没有「创作广场」");
  if (!out.opened) bad.push("点入口没进创作广场");
  if (out.title !== "创作广场") bad.push(`标题与本体不符：${out.title}`);

  /* ② 只收网页：三个 .html，一个 .md 不算 */
  if ((out.allApps ?? []).length !== 3) bad.push(`应用数不对（应 3 个 html）：${JSON.stringify(out.allApps)}`);
  if ((out.allApps ?? []).some((n) => n.includes("笔记"))) bad.push("Markdown 被当成了应用");
  if (!(out.allApps ?? []).includes("销售看板")) bad.push("没列出销售看板");

  const wantCats = ["全部", "数据看板", "教育培训", "游戏娱乐", "其他", "汇报演示", "效率工具", "网站设计"];
  if (JSON.stringify(out.categoryOptions) !== JSON.stringify(wantCats)) {
    bad.push(`分类与证据不符：${JSON.stringify(out.categoryOptions)}`);
  }
  if (out.safeTips !== "本地部署，注意内容合规与信息安全") bad.push(`合规提示与证据不符：${out.safeTips}`);

  /* ④ 分类 */
  if (JSON.stringify(out.gameApps) !== JSON.stringify(["贪吃蛇小游戏"])) {
    bad.push(`按分类筛不对：${JSON.stringify(out.gameApps)}`);
  }

  /* ③ 搜索 */
  if (JSON.stringify(out.searchHit) !== JSON.stringify(["销售看板"])) {
    bad.push(`搜「看板」结果不对：${JSON.stringify(out.searchHit)}`);
  }
  if (out.searchHitLabel !== "找到 1 个应用") bad.push(`命中数说法不对：${out.searchHitLabel}`);
  if (out.searchMissLabel !== "暂未搜索到匹配的应用") bad.push(`没命中时的说法不对：${out.searchMissLabel}`);
  if (out.searchMissEmpty !== "暂未搜索到匹配的应用") bad.push(`空态文案不对：${out.searchMissEmpty}`);

  /* ⑤ 时间 */
  if (JSON.stringify(out.daysOptions) !== JSON.stringify(["近 7 天", "近 30 天", "全部时间"])) {
    bad.push(`时间范围选项不对：${JSON.stringify(out.daysOptions)}`);
  }
  if ((out.recentApps ?? []).includes("老官网")) bad.push("近 7 天里出现了 100 天前更新的应用（时间没在切）");
  if (!(out.allDaysApps ?? []).includes("老官网")) bad.push("「全部时间」里少了老官网");
  if ((out.recentApps ?? []).length !== 2) bad.push(`近 7 天应剩 2 个：${JSON.stringify(out.recentApps)}`);

  /* ⑥ 排行 */
  if ((out.topRows ?? []).length !== 3) bad.push(`排行条数不对：${JSON.stringify(out.topRows)}`);
  if (!(out.topNote ?? "").includes("最近更新")) {
    bad.push(`排行的口径没写在界面上：${out.topNote}`);
  }

  /* ⑧ 容器与按钮（零覆盖清单里那一组，§208） */
  const CREATE_APP_LABEL = "创作应用";
  const PREVIEW_LABEL = "预览应用";
  if (!out.createBtn) bad.push("页头没有「创作应用」入口");
  else {
    if (out.createBtn.text !== CREATE_APP_LABEL) bad.push(`「创作应用」文案不对：${out.createBtn.text}`);
    if (out.createBtn.disabled) bad.push("⭐「创作应用」被禁用了（点了没反应的假入口）");
  }
  if (out.gridCount !== 1) bad.push(`有应用时应当有网格容器，实际 ${out.gridCount} 个`);
  if (!(out.gridWidth > 200)) bad.push(`⭐ 网格被挤塌了（宽 ${out.gridWidth}px）—— 中文会一字一行`);
  if ((out.previewButtons ?? []).length !== (out.allApps ?? []).length) {
    bad.push(`「${PREVIEW_LABEL}」按钮数与卡片数不符：${JSON.stringify(out.previewButtons)}`);
  }
  for (const b of out.previewButtons ?? []) {
    if (b.text !== PREVIEW_LABEL) bad.push(`${b.id} 文案不对：${b.text}`);
  }
  if (out.rankOpenButtons !== (out.topRows ?? []).length) {
    bad.push(`排行里每行都该有打开按钮：${out.rankOpenButtons} vs ${(out.topRows ?? []).length}`);
  }
  if (out.readNote !== 0) bad.push("读得到产物时不该出现「读不到产物目录」的告警");

  /* ⑦ 创作同款 */
  if (!out.backHome) bad.push("「创作同款」没有切回首页");
  if (!(out.composerText ?? "").includes("销售看板")) bad.push(`输入区里没有那句话：${out.composerText}`);
  if (!(out.composerText ?? "").includes("单文件 HTML")) bad.push("那句话不是能直接开工的委托");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 创作广场成立：只收网页产物 / 分类与搜索（含空态）/ 时间范围真在切 / 排行口径写明 / 创作同款填进输入区");
  }
}
