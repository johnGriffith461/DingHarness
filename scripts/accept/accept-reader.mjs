import { chromium } from "playwright";
import fs from "node:fs";
import { bootApp, freshDir, killTree, shot } from "./harness.mjs";

/**
 * 验收：**AI 阅读**（§155，对应 `chat/read-web`）。
 *
 * ## 这条**不调模型**（进批跑）—— 侧栏三件事全是本地算得准的
 *
 * 六条断言：
 * ① 入口（输入区 `+` → 进入 AI 阅读）真的能进
 * ② 文案与本体逐字一致（`进入 AI 阅读 / 隐藏侧栏 / 大纲 / 页面 / 图表 / 最近阅读`）
 * ③ **大纲**抽得对（层级 + 顺序），且**代码块里的 `#` 不算标题**
 * ④ **页面检索**给出行号/页号；空关键词不返回"全中"
 * ⑤ **图表**抽出表格并数出图片
 * ⑥ 「最近阅读」收进去后**重开还在**（落盘），点它能重新打开
 */
const DATA = "D:/DoubaoWorkClone/.verify/reader-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

const PORT = 9304;
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

/** 内容里刻意放：两级标题、代码块里的假标题、一张表格、一张图片。 */
const DOC = [
  "# 季度复盘",
  "",
  "本季度整体完成度不错。",
  "",
  "```bash",
  "# 这只是注释，不是标题",
  "```",
  "",
  "## 数据",
  "",
  "| 指标 | 数值 |",
  "| --- | --- |",
  "| 收入 | 120 |",
  "| 成本 | 80 |",
  "",
  "![折线图](img/trend.png)",
  "",
  "## 结论",
  "",
  "继续保持。",
].join("\n");

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  let b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  let ctx = b.contexts()[0];
  let page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* ── ① 入口 ── */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  out.menuHasReader = await page.evaluate(
    () => document.querySelector('[data-testid="wb-add-pop"]')?.textContent?.includes("进入 AI 阅读") ?? false,
  );
  await page.locator('[data-testid="wb-add-reader"]').click();
  await page.waitForTimeout(1000);
  out.opened = (await page.locator('[data-testid="wb-reader"]').count()) > 0;

  /* ── ② 空态与文案 ── */
  out.emptyText = await page.evaluate(
    () => document.querySelector('[data-testid="wb-reader-empty"]')?.textContent?.trim() ?? "",
  );
  out.tabLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-reader-tab-"]')).map((e) => (e.textContent ?? "").trim()),
  );

  /* 进入阅读 */
  await page.locator('[data-testid="wb-reader-input"]').fill(DOC);
  await page.locator('[data-testid="wb-reader-enter"]').click();
  await page.waitForTimeout(800);
  out.titleText = await page.evaluate(
    () => document.querySelector('[data-testid="wb-reader-title"]')?.textContent?.trim() ?? "",
  );
  out.statsText = await page.evaluate(
    () => document.querySelector('[data-testid="wb-reader-stats"]')?.textContent?.trim() ?? "",
  );

  /* ── ③ 大纲 ── */
  out.outline = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-reader-outline"] li')).map((e) =>
      (e.textContent ?? "").trim(),
    ),
  );
  out.outlineHasFakeHeading = (out.outline ?? []).some((x) => x.includes("这只是注释"));

  /* ── ④ 页面检索 ── */
  await page.locator('[data-testid="wb-reader-tab-page"]').click();
  await page.waitForTimeout(300);
  out.hitsBeforeQuery = await page.locator('[data-testid="wb-reader-hits"]').count();
  await page.locator('[data-testid="wb-reader-search"]').fill("收入");
  await page.waitForTimeout(400);
  out.hits = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-reader-hits"] li')).map((e) => (e.textContent ?? "").trim()),
  );
  await page.locator('[data-testid="wb-reader-search"]').fill("不存在的词");
  await page.waitForTimeout(400);
  out.hitsNone = await page.evaluate(
    () => document.querySelector('[data-testid="wb-reader-hits"]')?.textContent?.trim() ?? "",
  );

  /* ── ⑤ 图表 ── */
  await page.locator('[data-testid="wb-reader-tab-chart"]').click();
  await page.waitForTimeout(300);
  out.charts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-reader-charts"] li')).map((e) =>
      (e.textContent ?? "").trim(),
    ),
  );

  /* ── ⑥ 收进最近阅读 + 隐藏侧栏 ── */
  await page.locator('[data-testid="wb-reader-save"]').click();
  await page.waitForTimeout(900);
  out.recentTitles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-reader-recent-"]')).map((e) => (e.textContent ?? "").trim()),
  );

  /*
   * ⚠️ 2026-10-13 补：`wb-reader-saved` 与 `wb-reader-desc` 这两个 testid
   * **原来没有任何脚本引用过**（`src/` × `scripts/accept/` 交叉，见 HANDOFF §208 的零覆盖清单）。
   * 断**后果**：收进最近阅读之后那句「已收进最近阅读」**真的出现**（不是静默成功）；
   * 每个页签下那行说明**非空**（空说明等于这个页签没人解释它是干什么的）。
   */
  out.savedHint = await page.evaluate(
    () => document.querySelector('[data-testid="wb-reader-saved"]')?.textContent?.trim() ?? "",
  );
  out.descByTab = {};
  for (const t of ["outline", "page", "chart"]) {
    await page.locator(`[data-testid="wb-reader-tab-${t}"]`).click();
    await page.waitForTimeout(300);
    out.descByTab[t] = await page.evaluate(
      () => document.querySelector('[data-testid="wb-reader-desc"]')?.textContent?.trim() ?? "",
    );
  }
  await page.locator('[data-testid="wb-reader-sidebar-toggle"]').click();
  await page.waitForTimeout(400);
  out.sidebarHidden = (await page.locator('[data-testid="wb-reader-side"]').count()) === 0;
  await page.locator('[data-testid="wb-reader-sidebar-toggle"]').click();
  await page.waitForTimeout(400);
  out.sidebarBack = (await page.locator('[data-testid="wb-reader-side"]').count()) > 0;
  out.shot = await shot(page, "reader.png");
  await b.close();

  /* ── 重启：最近阅读要还在 ── */
  await killTree(child);
  await new Promise((r) => setTimeout(r, 1500));
  if (!(await boot())) {
    out.error = "重启失败：" + (getLog() || "(空)").slice(-300);
  } else {
    b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    ctx = b.contexts()[0];
    page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
    await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
    await page.locator('[data-testid="wb-composer-add"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="wb-add-reader"]').click();
    await page.waitForTimeout(1200);
    out.recentAfterRestart = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="wb-reader-recent-"]')).map((e) => (e.textContent ?? "").trim()),
    );
    // 点它能重新打开
    if (out.recentAfterRestart?.length) {
      await page.locator('[data-testid^="wb-reader-recent-"]').first().click();
      await page.waitForTimeout(600);
    }
    out.reopenedTitle = await page.evaluate(
      () => document.querySelector('[data-testid="wb-reader-title"]')?.textContent?.trim() ?? "",
    );

    /*
     * ⚠️ `wb-reader-forget-*`（最近阅读里那条「移除」）原来也没有脚本点过（§208）。
     * 断**后果**：点下去那一行**真的没了**，并且落盘的那份也少了（重启后不会再冒出来）。
     */
    const forgetId = await page.evaluate(
      () => document.querySelector('[data-testid^="wb-reader-forget-"]')?.getAttribute("data-testid") ?? "",
    );
    out.forgetId = forgetId;
    if (forgetId) {
      await page.locator(`[data-testid="${forgetId}"]`).click();
      await page.waitForTimeout(900);
    }
    out.recentAfterForget = await page.locator('[data-testid^="wb-reader-recent-"]').count();
    await b.close();
  }
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.menuHasReader) bad.push("+ 菜单里没有「进入 AI 阅读」");
  if (!out.opened) bad.push("点入口没进阅读面板");
  if (!(out.emptyText ?? "").includes("还没有内容")) bad.push(`空态文案不对：${out.emptyText}`);
  if (JSON.stringify(out.tabLabels) !== JSON.stringify(["大纲", "页面", "图表"])) {
    bad.push(`侧栏页签与本体不符：${JSON.stringify(out.tabLabels)}`);
  }

  if (out.titleText !== "季度复盘") bad.push(`标题没取到：${out.titleText}`);
  if (!/字/.test(out.statsText ?? "")) bad.push(`统计没显示：${out.statsText}`);

  if ((out.outline ?? []).length !== 3) bad.push(`大纲条数不对：${JSON.stringify(out.outline)}`);
  if (!(out.outline ?? []).some((x) => x.includes("季度复盘"))) bad.push("大纲里没有一级标题");
  if (out.outlineHasFakeHeading) bad.push("代码块里的假标题混进了大纲");

  if (out.hitsBeforeQuery !== 0) bad.push("没输关键词就给出了命中列表");
  if ((out.hits ?? []).length !== 1) bad.push(`检索「收入」结果不对：${JSON.stringify(out.hits)}`);
  if (!(out.hits?.[0] ?? "").includes("第 1 页")) bad.push(`命中没带页号：${out.hits?.[0]}`);
  if (!(out.hitsNone ?? "").includes("没有找到")) bad.push(`检索不到时没有说明：${out.hitsNone}`);

  if (!(out.charts ?? []).some((x) => x.includes("表格") && x.includes("指标"))) {
    bad.push(`图表没抽到表格：${JSON.stringify(out.charts)}`);
  }
  if (!(out.charts ?? []).some((x) => x.includes("图片 1 张"))) {
    bad.push(`图表没数出图片：${JSON.stringify(out.charts)}`);
  }

  if (!(out.recentTitles ?? []).some((x) => x.includes("季度复盘"))) {
    bad.push(`最近阅读没收录：${JSON.stringify(out.recentTitles)}`);
  }
  if (!out.sidebarHidden) bad.push("「隐藏侧栏」没把侧栏收起来");
  if (!out.sidebarBack) bad.push("侧栏收起来之后切不回来");

  if (!(out.recentAfterRestart ?? []).some((x) => x.includes("季度复盘"))) {
    bad.push(`重开后最近阅读没恢复：${JSON.stringify(out.recentAfterRestart)}`);
  }
  if (!(out.reopenedTitle ?? "").includes("季度复盘")) bad.push(`点最近阅读没打开内容：${out.reopenedTitle}`);

  /* 补的那组（零覆盖清单里的「已收进最近阅读」/ 页签说明 / 移除，§208） */
  if (out.savedHint !== "已收进最近阅读") bad.push(`收进之后那句提示不对：${JSON.stringify(out.savedHint)}`);
  for (const t of ["outline", "page", "chart"]) {
    if (!(out.descByTab?.[t] ?? "").trim()) bad.push(`「${t}」页签下那行说明是空的`);
  }
  const descs = Object.values(out.descByTab ?? {});
  if (new Set(descs).size !== descs.length) bad.push(`三个页签的说明应当各不相同：${JSON.stringify(out.descByTab)}`);
  if (!out.forgetId) bad.push("最近阅读那一行上没有「移除」按钮（wb-reader-forget-*）");
  if (out.recentAfterForget !== 0) bad.push(`点了「移除」那一行还在：${out.recentAfterForget}`);

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ AI 阅读成立：入口 / 文案对齐 / 大纲（代码块里的假标题不算）/ 页面检索 / 图表 / 最近阅读可落盘重开");
  }
}
