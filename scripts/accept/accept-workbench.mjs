import { chromium } from "playwright";
import path from "node:path";
import {
  NO_PAGE_HINT,
  bootApp,
  connectWithRetry,
  failOnMarks,
  freshDir,
  killTree,
  openCanvas,
  openPluginsPage,
  openSummary,
  pickPort,
  shot,
  verdict,
  waitForPage,
} from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

/**
 * 工作台外壳验收（阶段 10）。
 *
 * 断言对齐实机遍历到的东西（HANDOFF §25）：
 *   1. 三栏都在：左导航 / 中任务 / 右摘要
 *   2. 左导航项都在，带快捷键提示
 *   3. 页面都能打开（定时任务预设卡 / 插件页 tab + 分类 + 安装按钮 / 手机遥控两个开关 + 二维码）
 *   4. 设置弹窗能开
 *   5. 画布作为产物面板能开合
 *   6. **发一条任务真的跑起来**：左侧出现自动命名的任务行、任务视图打开
 *
 * ⚠️ 两处 2026-10-16 的订正（都在把清单外的脚本并进批跑那一轮里做）：
 *   · **启动改用 `bootApp`**：原来自己 `spawn` + `waitForPort` + `connectOverCDP` ——
 *     这台机器上有「TCP 连得上、Electron 的调试服务器却不答」的端口区间，
 *     裸写法会卡死在连 CDP 那一步（实测：整条脚本 30 秒一个字都不打）；
 *   · **插件入口换成 `openPluginsPage`**：`wb-nav-plugins` 那个导航项**早就拆了**
 *     （导航收敛成 新工作任务 / 定时任务 / 手机遥控 三项，插件搬进设置里，
 *     走「技能」下拉 →「技能管理」）。脚本没跟上，于是卡在点不到的那个 testid 上 30 秒 ——
 *     **红的是脚本过期，不是产品坏了**。仓里已经有好几条脚本改用这个助手了。
 */
const DATA = ".verify/wb-data";
/*
 * ⚠️ `freshDir` 而不是裸 `rmSync`（§135）：上一条脚本异常退出时留下的实例还占着目录，
 * 裸删会 `EPERM`，看起来像"产品坏了"。
 */
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const booted = await bootApp({ port: await pickPort([12520]), dataDir: DATA, timeoutMs: 40_000 });
if (!booted.ok) {
  console.error("[诊断] 应用输出尾部：" + (booted.getLog() || "(空)").slice(-1200));
  await killTree(booted.child);
  process.exit(1);
}
const browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
const page = await waitForPage(browser);
if (!page) throw new Error(NO_PAGE_HINT);
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console error]", m.text().slice(0, 200));
});
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const shots = ".verify/shots-final";
const report = {};

// 1) 三栏
report.columns = {
  nav: await page.locator('[data-testid="wb-nav"]').count(),
  main: await page.locator(".wb-main").count(),
  summary: await page.locator('[data-testid="wb-summary"]').count(),
};
report.navWidth = await page.evaluate(() => Math.round(document.querySelector(".wb-nav").getBoundingClientRect().width));
report.summaryWidth = await page.evaluate(() =>
  Math.round(document.querySelector(".wb-summary").getBoundingClientRect().width),
);

// 2) 五项导航 + 快捷键
report.navItems = await page.$$eval('[data-testid^="wb-nav-"]', (els) =>
  els.map((e) => e.textContent.replace(/\s+/g, " ").trim()),
);
report.shortcuts = await page.$$eval(".wb-kbd", (els) => els.map((e) => e.textContent.trim()));

// 首页
report.homeTitle = await page.locator(".wb-home-title").textContent();
report.suggestions = await page.$$eval(".wb-suggestion", (els) => els.map((e) => e.textContent.trim()));
await shot(page, path.join(shots, "wb-01-home.png"));

// 3) 五个页面
const visit = async (view, file) => {
  await page.locator(`[data-testid="wb-nav-${view}"]`).click();
  await page.waitForTimeout(700);
  await shot(page, path.join(shots, file));
};
await visit("scheduled", "wb-02-scheduled.png");
report.scheduled = {
  presets: await page.$$eval(".wb-preset", (els) => els.map((e) => e.querySelector("b").textContent)),
  hasNew: await page.locator('[data-testid="wb-sched-new"]').count(),
};
/*
 * ⚠️ 插件页**不再走左栏导航**（那个 `wb-nav-plugins` 早拆了，见文件头）——
 * 用 `openPluginsPage`：它点的是输入区「技能」下拉 →「技能管理」。
 * 默认进的是**管理子页**，市场页要 `{ market: true }` 才回得来（两者是两套 tab）。
 *
 * ⚠️ 而**输入区只在首页 / 任务视图上**（`HomeView` 与 `TaskView` 各渲染一个 `Composer`）——
 * 上一步停在「定时任务」页，直接点 `wb-skills` 会等 30 秒超时。所以先回首页。
 */
await page.locator('[data-testid="wb-nav-home"]').click();
await page.waitForTimeout(600);
report.pluginsOpened = await openPluginsPage(page, { market: true });
await page.waitForTimeout(800);
await shot(page, path.join(shots, "wb-03-plugins.png"));
report.plugins = {
  tabs: await page.$$eval(".wb-tab", (els) => els.map((e) => e.textContent.trim())),
  categories: await page.$$eval(".wb-cat", (els) => els.map((e) => e.textContent.trim())),
  featured: await page.$$eval(".wb-feature-text b", (els) => els.map((e) => e.textContent)),
  recommended: await page.locator(".wb-plugin").count(),
  installButtons: await page.locator(".wb-install").count(),
};
await page.locator('[data-testid="wb-plugin-tab-技能"]').click();
await page.waitForTimeout(500);
report.skillsTab = await page.$$eval(".wb-group-title", (els) => els.map((e) => e.textContent.trim()));
await shot(page, path.join(shots, "wb-04-skills-tab.png"));

/* ⚠️ 2026-10-16：云盘整页拆了，这一格（访问 cloud 视图）删掉。 */

/*
 * C-01（2026-10-20）：「手机遥控电脑」从主导航移进了设置。
 * 走真实路径：账号菜单 → 设置 → 手机遥控电脑。
 */
await page.locator('[data-testid="wb-account"]').click();
await page.waitForTimeout(400);
await page.locator('[data-testid="wb-acct-settings"]').click();
await page.waitForSelector('[data-testid="wb-set-手机遥控电脑"]', { timeout: 8000 });
await page.locator('[data-testid="wb-set-手机遥控电脑"]').click();
await page.waitForTimeout(1800);
await shot(page, path.join(shots, "wb-06-phone.png"));
report.phone = {
  heading: await page.locator(".wb-page-h2").textContent(),
  switches: await page.$$eval(".wb-switch-text", (els) => els.map((e) => e.textContent.trim())),
  steps: await page.$$eval(".wb-step b", (els) => els.map((e) => e.textContent.trim())),
  qr: await page.locator(".wb-qr-box").count(),
};
/* 关掉设置，后面「设置弹窗」那一段要重新打开它 */
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

// 4) 设置弹窗
/*
 * ⚠️ 2026-10-13 修：这里原来点完 `wb-account` 就等弹窗 —— 而账号按钮**早就改成下拉菜单**了
 * （§107/R1：账号 → 菜单 → 「设置」）。脚本没跟上，于是这条**一直过期**
 * （它不在免模型批跑的 52 条里，所以没人发现 —— 正是 §97 点过的那种"久没跑过"）。
 */
await page.locator('[data-testid="wb-account"]').click();
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-acct-settings"]').click();
await page.waitForTimeout(800);
report.settingsRows = await page.$$eval(".wb-modal-row", (els) =>
  els.map((e) => e.textContent.replace(/\s+/g, " ").trim()),
);
/* 身份那句与关闭键 2026-10-16 挪进了顶栏（原来是散在 body 里的 `.wb-modal-id` / `.wb-modal-close`） */
report.settingsId = await page.locator('[data-testid="wb-set-mode"]').textContent();
await shot(page, path.join(shots, "wb-07-settings.png"));
await page.locator('[data-testid="wb-settings-close"]').click();
await page.waitForTimeout(400);

// 5) 画布产物面板开合
/* ⚠️ `openCanvas` 点的是输入区「技能」面板里的那颗（`wb-canvas-toggle`）—— 先回首页（同上）。 */
await page.locator('[data-testid="wb-nav-home"]').click();
await page.waitForTimeout(600);
report.canvasBefore = await page.locator('[data-testid="wb-canvas"]').count();
  await openCanvas(page);
  await page.waitForTimeout(1500);
report.canvasAfterToggle = await page.locator('[data-testid="wb-canvas"]').count();
  await openCanvas(page);
  await page.waitForTimeout(1500);

// 5b) 右侧面板是四个 tab（上位 sidePanel_summary_tab_*）
// 右栏 2026-10-14 起默认收起（照原型）→ 先展开
report.summaryOpened = await openSummary(page);
report.summaryTabs = await page.$$eval('[data-testid^="wb-summary-tab-"]', (els) =>
  els.map((e) => e.textContent.trim()),
);
report.summaryTabsKeys = await page.$$eval('[data-testid^="wb-summary-tab-"]', (els) =>
  els.map((e) => e.getAttribute("title")),
);
await page.locator('[data-testid="wb-summary-tab-browser"]').click();
await page.waitForTimeout(400);
report.browserTabEmpty = await page.locator('[data-testid="wb-summary-empty-browser"]').count();
await page.locator('[data-testid="wb-summary-tab-artifacts"]').click();
await page.waitForTimeout(400);

// 5c) 定时任务是 id→文案映射（9 条超集里发 7 条）
await page.locator('[data-testid="wb-nav-scheduled"]').click();
await page.waitForTimeout(600);
report.schedPresets = await page.$$eval(".wb-preset", (els) =>
  els.map((e) => ({
    key: e.getAttribute("title"),
    title: e.querySelector("b")?.textContent ?? "",
  })),
);

// 6) 发一条任务
await page.locator('[data-testid="wb-nav-home"]').click();
await page.waitForTimeout(500);
await page.locator('[data-testid="wb-composer-input"]').fill("帮我写一份简短的产品周报，包含本周进展与下周计划");
await page.locator('[data-testid="wb-send"]').click();
await page.waitForTimeout(1200);

report.taskView = {
  opened: await page.locator('[data-testid="wb-task"]').count(),
  title: await page.locator('[data-testid="wb-task-title"]').textContent(),
  recent: await page.$$eval('[data-testid^="wb-recent-"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, " ").trim()),
  ),
};
await shot(page, path.join(shots, "wb-08-task-running.png"));

/*
 * 等这一轮落到界面上（最多 90 秒），期间看进度计时是否在走。
 *
 * ⚠️ 退出条件补了"助手正文出现"（2026-10-16）：原来只等**提问卡** ——
 * 而提问卡是模型追问时才有的，批跑里那条路根本不出现，于是这一格**每次都干等 90 秒**
 * （既慢、又不判定任何事）。现在"正文出现"也算这一轮走完了。
 */
const ticks = [];
for (let i = 0; i < 30; i += 1) {
  await page.waitForTimeout(3000);
  const label = await page.locator('[data-testid="wb-progress"]').textContent().catch(() => "");
  if (label) ticks.push(label.replace(/\s+/g, " ").trim());
  if ((await page.locator('[data-testid="wb-question-card"]').count()) > 0) break;
  if ((await page.locator(".wb-assistant-text").count()) > 0) break;
}

report.progressSamples = ticks.slice(0, 5);
report.assistantTexts = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".wb-assistant-text")).map((e) => (e.textContent ?? "").slice(0, 120)),
);
report.questionCard = await page.locator('[data-testid="wb-question-card"]').count();
report.question = {
  text: await page.locator(".wb-question-text").textContent().catch(() => null),
  page: await page.locator('[data-testid="wb-question-progress"]').textContent().catch(() => null),
  options: await page.$$eval(".wb-option", (els) =>
    els.map((e) => ({
      label: e.querySelector("b")?.textContent ?? "",
      hint: e.querySelector("em")?.textContent ?? "",
    })),
  ),
  customInput: await page.locator('[data-testid="wb-custom-answer"]').count(),
};
report.pendingBadge = await page.locator('[data-testid^="wb-pending-"]').count();
await shot(page, path.join(shots, "wb-09-question.png"));

// 7) 答一题
if (report.questionCard > 0) {
  await page.locator('[data-testid="wb-option-0"]').click();
  await page.waitForTimeout(2500);
  report.afterAnswer = {
    page: await page.locator('[data-testid="wb-question-progress"]').textContent().catch(() => null),
    bubbleCount: await page.locator(".wb-bubble-user").count(),
  };
  await shot(page, path.join(shots, "wb-10-answered.png"));
}

// 消息操作栏
report.messageActions = await page.$$eval('[data-testid="wb-message-actions"] .wb-icon', (els) => els.length);
report.costShown = await page.locator(".wb-cost").count();

console.log(JSON.stringify(report, null, 2));
await browser.close();
await killTree(booted.child);

/*
 * ── 判定（2026-10-16 补）──
 *
 * 这条脚本原来**只有 `console.log(report)`** —— 在批跑里那是"跑通但没有判定"
 * （`verify-acceptances.mjs` 的 `no-judge` 那一类，等于没测）。
 * 下面断的是它这一路真的走通了什么，逐条对着 report 里那些字段来。
 */
const bad = [];
/* 1) 三栏都在（外壳的骨架） */
if (report.columns.nav !== 1) bad.push("左导航栏没找到（wb-nav）");
if (report.columns.main < 1) bad.push("中间任务区没找到（.wb-main）");
if (report.columns.summary !== 1) bad.push("右摘要栏没找到（wb-summary）");
if (!(report.navWidth > 40)) bad.push(`左栏宽度不对：${report.navWidth}px`);
/* 2) 左导航项与快捷键提示（导航 2026-10-16 收敛成三项，这里断"至少三项且都有标签"） */
if ((report.navItems ?? []).length < 3) bad.push(`左导航项少于三项：${JSON.stringify(report.navItems)}`);
if ((report.navItems ?? []).some((t) => !String(t ?? "").trim())) bad.push("有导航项没有文字（点不着的空行）");
if ((report.shortcuts ?? []).length < 1) bad.push("没有任何快捷键提示（.wb-kbd 一个都没有）");
/* 3) 各页面真的打开了 */
if (!(report.scheduled?.presets ?? []).length) bad.push("定时任务页没有预设卡");
if (!report.pluginsOpened) bad.push("插件页没打开（入口还是旧的那个吗？见文件头）");
if (!(report.plugins?.tabs ?? []).length) bad.push(`插件页没有 tab：${JSON.stringify(report.plugins?.tabs)}`);
if (!(report.plugins?.categories ?? []).length) bad.push("插件页没有分类");
if (!((report.plugins?.recommended ?? 0) + (report.plugins?.installButtons ?? 0) > 0)) {
  bad.push("插件页没有列出任何可装的东西");
}
if (!(report.phone?.switches ?? []).length) bad.push("手机遥控页没有开关");
if (!report.phone?.qr) bad.push("手机遥控页没有二维码框");
/* 4) 设置弹窗 */
if (!(report.settingsRows ?? []).length) bad.push("设置弹窗没有行");
if (!String(report.settingsId ?? "").includes("模式")) bad.push(`设置的身份那句没读到：${report.settingsId}`);
/* 5) 画布开合 + 右摘要四个 tab */
if (!report.canvasAfterToggle) bad.push("画布面板没能打开");
if (!report.summaryOpened) bad.push("右摘要面板没能展开");
if ((report.summaryTabs ?? []).length < 2) bad.push(`右摘要 tab 少于两个：${JSON.stringify(report.summaryTabs)}`);
/* 6) 发一条任务真的跑起来 */
if (!report.taskView?.opened) bad.push("发了任务但任务视图没打开");
if (!String(report.taskView?.title ?? "").trim()) bad.push("任务标题是空的（自动命名没生效）");
if (!(report.taskView?.recent ?? []).length) bad.push("左栏「最近」里没有这一条任务");
/* 7) 这一轮真的落到了界面上（助手正文出现 —— 假通道也算，判的是链路通不通） */
if (!(report.assistantTexts ?? []).length) bad.push("这一轮没有助手正文（发送之后什么都没回来）");

verdict(bad, "工作台外壳成立：三栏 / 导航与快捷键 / 各页面 / 设置 / 画布开合 / 右摘要 tab / 发任务真跑起来");
