import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { shot } from "./harness.mjs";

/**
 * 工作台外壳验收（阶段 10）。
 *
 * 断言对齐实机遍历到的东西（HANDOFF §25）：
 *   1. 三栏都在：左导航 / 中任务 / 右摘要
 *   2. 左导航五项齐全，带快捷键提示
 *   3. 五个页面都能打开（定时任务 7 张预设卡 / 插件 3 tab + 12 分类 + 安装按钮 /
 *      云盘 三 tab + 表格 / 手机遥控 两个开关 + 二维码）
 *   4. 设置弹窗能开，含实测的六行
 *   5. 画布作为产物面板能开合
 *   6. **发一条任务真的跑起来**：左侧出现自动命名的任务行、进度计时在走
 *   7. 提问卡出现时：分页、编号选项、自定义输入都在（真实模型产出，不是假数据）
 */
const DATA = "D:/DoubaoWorkClone/.verify/wb-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9520"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9520");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console error]", m.text().slice(0, 200));
});
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const shots = "D:/DoubaoWorkClone/.verify/shots-final";
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
await visit("plugins", "wb-03-plugins.png");
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

await visit("cloud", "wb-05-cloud.png");
report.cloud = {
  tabs: await page.$$eval(".wb-tab", (els) => els.map((e) => e.textContent.trim())),
  headers: await page.$$eval(".wb-th span", (els) => els.map((e) => e.textContent.trim())),
  rows: await page.locator(".wb-tr").count(),
  foot: await page.locator(".wb-cloud-foot").textContent(),
};

await visit("phone", "wb-06-phone.png");
report.phone = {
  heading: await page.locator(".wb-page-h2").textContent(),
  switches: await page.$$eval(".wb-switch-text", (els) => els.map((e) => e.textContent.trim())),
  steps: await page.$$eval(".wb-step b", (els) => els.map((e) => e.textContent.trim())),
  qr: await page.locator(".wb-qr-box").count(),
};

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
report.settingsId = await page.locator(".wb-modal-id").textContent();
await shot(page, path.join(shots, "wb-07-settings.png"));
await page.locator(".wb-modal-close").click();
await page.waitForTimeout(400);

// 5) 画布产物面板开合
report.canvasBefore = await page.locator('[data-testid="wb-canvas"]').count();
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);
report.canvasAfterToggle = await page.locator('[data-testid="wb-canvas"]').count();
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);

// 5b) 右侧面板是四个 tab（上位 sidePanel_summary_tab_*）
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

// 等模型回（最多 90 秒），期间看进度计时是否在走
const ticks = [];
for (let i = 0; i < 30; i += 1) {
  await page.waitForTimeout(3000);
  const label = await page.locator('[data-testid="wb-progress"]').textContent().catch(() => "");
  if (label) ticks.push(label.replace(/\s+/g, " ").trim());
  const answered = await page.locator('[data-testid="wb-question-card"]').count();
  if (answered > 0) break;
}

report.progressSamples = ticks.slice(0, 5);
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
child.kill();
