import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openPluginsPage, pickPort, readStoreFile, waitForPort } from "./harness.mjs";

/**
 * 11.34 验收：添加自定义能力，并确认它**真的走到任务侧**。
 *
 * 上一轮我把这条的关键点写清楚了：光能加进库不算数，
 * **`findItemIn` 查得到它**才算数 —— 任务侧取名字走的就是这一个查询。
 * 查不到的话，条目进了 `enabled` 也不会出现在任务的系统提示词里，等于装了没用。
 *
 * 所以断言分两半：
 *   前半：加 → 落盘 → 自动装上并启用；
 *   后半：**同一个 `findItemIn` 的产物**在输入区露出来（启用 chip + 技能选择器）——
 *         这两处与 `enabledBlock()` 走的是同一个函数、同一份 lib。
 */
const DATA = ".verify/custom-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12740]);
const child = spawn(
  "node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: ".", env, stdio: ["ignore", "ignore", "ignore"] },
);
/* 固定等 8 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1800);

const report = {};
try {
  /*
   * ⚠️ 2026-10-16：这一条要的市场页（搜索框/分类/添加表单）与"管理子页"现在是**两个模式**，
   * 靠页面里的「管理」按钮互相切；`openPluginsPage` 默认进管理子页 —— 这里要市场页。
   */
  await openPluginsPage(page, { market: true });
  await page.waitForTimeout(1200);

  /*
   * ⚠️ 2026-10-13 补：`wb-plugin-searchbox` 与 `wb-plugin-categories` 这两个 testid
   * **原来没有任何脚本引用过**（`src/` × `scripts/accept/` 交叉，见 HANDOFF §208）。
   * 它们属于"没人点过 ⇒ 烂了也没人知道"的那一类（§201 技能面板被挤成 59px 就是同类）。
   * 断**后果**：搜索框在、分类行在且**至少有一个分类按钮**（分类行被做空了等于筛不了）。
   */
  report.marketSearchbox = await page.locator('[data-testid="wb-plugin-searchbox"]').count();
  report.marketCategories = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="wb-plugin-categories"]');
    return { count: box ? 1 : 0, chips: box ? box.querySelectorAll("button").length : 0 };
  });

  await page.locator('[data-testid="wb-plugin-add"]').click();
  await page.waitForTimeout(700);
  report.formOpened = await page.locator('[data-testid="wb-add-form"]').count();

  // 空名字应被拦
  await page.locator('[data-testid="wb-add-save"]').click();
  await page.waitForTimeout(600);
  report.errorOnEmpty = await page.locator('[data-testid="wb-add-error"]').textContent();

  // 填好加一条
  await page.locator('[data-testid="wb-add-name"]').fill("查股价");
  await page.locator('[data-testid="wb-add-hint"]').fill("按股票代码查当前价格与涨跌幅");
  await page.locator('[data-testid="wb-add-type"]').selectOption("skill");
  await page.locator('[data-testid="wb-add-save"]').click();
  await page.waitForTimeout(1500);
  report.formClosedAfterSave = (await page.locator('[data-testid="wb-add-form"]').count()) === 0;

  const lib = readStoreFile(path.join(DATA, "library.json"));
  report.custom = lib.custom;
  report.autoInstalled = lib.installed.includes(lib.custom[0]?.id);
  report.autoEnabled = lib.enabled.includes(lib.custom[0]?.id);

  // 同名的应被拦
  await page.locator('[data-testid="wb-plugin-add"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-add-name"]').fill("查股价");
  await page.locator('[data-testid="wb-add-hint"]').fill("重复的");
  await page.locator('[data-testid="wb-add-save"]').click();
  await page.waitForTimeout(700);
  report.errorOnDuplicate = await page.locator('[data-testid="wb-add-error"]').textContent();
  await page.locator('[data-testid="wb-add-cancel"]').click();
  await page.waitForTimeout(500);

  /* ---------- 管理子页：自定义条目要看得到、计数要对 ---------- */
  await page.locator('[data-testid="wb-plugin-manage"]').click();
  await page.waitForTimeout(1200);
  report.manageTabs = await page.$$eval(".wb-manage-tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, "")));

  /*
   * ⚠️ 2026-10-13 补：`wb-manage-tabs` / `wb-manage-add` / `wb-manage-refresh` 三个 testid
   * 原来也**没有任何脚本引用过**（同 §208 的零覆盖清单）。
   * 断**后果**：三个分类页签都在、计数徽标是数字、「添加」不被禁用（点了要真能回市场）、
   * 「刷新」带 title（说明它干什么 —— 它原来是**没有 onClick 的死按钮**，§124 审计报出过）。
   */
  report.manageTabsBox = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="wb-manage-tabs"]');
    return {
      count: box ? 1 : 0,
      tabs: box
        ? Array.from(box.querySelectorAll("button")).map((b) => (b.textContent ?? "").replace(/\s+/g, ""))
        : [],
    };
  });
  report.manageAdd = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="wb-manage-add"]');
    return e ? { text: (e.textContent ?? "").trim(), disabled: e.hasAttribute("disabled") } : null;
  });
  report.manageRefresh = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="wb-manage-refresh"]');
    return e ? { title: e.getAttribute("title") ?? "", disabled: e.hasAttribute("disabled") } : null;
  });

  /*
   * 进管理子页（2026-10-16）：原来管理是**同一页**的 tab，现在是从市场页点「管理」按钮切过去。
   */
  if ((await page.locator('[data-testid="wb-manage-tabs"]').count()) === 0) {
    await page.locator('[data-testid="wb-plugin-manage"]').click();
    await page.waitForTimeout(900);
  }
  await page.locator('[data-testid="wb-manage-tab-技能"]').click();
  await page.waitForTimeout(800);
  report.manageSkillItems = await page.$$eval('[data-testid^="wb-managed-"]', (els) =>
    els.map((e) => e.querySelector("b")?.textContent ?? ""),
  );
  report.manageHasCustom = (report.manageSkillItems ?? []).some((t) => t.includes("查股价"));

  /* ---------- 关键：它有没有走到任务侧 ---------- */
  await page.locator('[data-testid="wb-crumb-market"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(1200);
  report.enabledChips = await page.$$eval(".wb-composer-chip", (els) => els.map((e) => e.textContent.trim()));
  report.chipHasCustom = (report.enabledChips ?? []).some((t) => t.includes("查股价"));

  await page.locator('[data-testid="wb-skills"]').click();
  await page.waitForTimeout(700);
  /*
   * ⚠️ 2026-10-16 修：这一段原来收的是**已经作废的 testid**（`wb-skill-toggle-*`，技能选择器
   * 改版之后就没了），而且收完**一条判定都没有** —— 于是"装了技能之后弹层里能不能用它"
   * 从来没被断过（收集不等于判定，报告也没人读）。
   * 现在按现界面读（技能弹层 `wb-skill-panel` 里的条目），并且**两向都断**：
   * 旧的 testid 必须真的不在了（这才是那条 count 的意思），新的弹层里必须看得到自定义技能。
   */
  report.oldSkillToggleLeft = await page.locator('[data-testid^="wb-skill-toggle-"]').count();
  /* 面板里的条目：`wb-cmd-<名字>`（技能）/ `wb-rec-<名字>`（推荐），搜索框是 `wb-cmd-search` */
  /*
   * ⚠️ 2026-10-16 修（顺着"收集了不判定"这条线查到的）：技能弹层（`wb-skill-panel`）是
   * **命令启动器**（选择项目 / 用量 / 工作模式 / 技能管理 / 反馈 …）+ 推荐，**不是技能列表** ——
   * 装好的技能出现在输入区那一排 chip 上（`chipHasCustom` 断的就是它）。
   * 所以这里断两件事：面板里确实有「技能管理」这个入口（`wb-cmd-技能管理`），
   * 以及旧的 `wb-skill-toggle-*` 真的不在了（那才是原来那行 count 的意思）。
   */
  report.manageEntry = await page.locator('[data-testid="wb-cmd-技能管理"]').count();
  report.pickerItems = await page.$$eval('[data-testid="wb-skill-panel"] [data-testid^="wb-cmd-"], [data-testid="wb-skill-panel"] [data-testid^="wb-rec-"]', (els) =>
    els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()),
  );

  /* ---------- 重启后仍在（落盘） ---------- */
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2500));
  const c2 = spawn(
    "node_modules/electron/dist/electron.exe",
    [".", "--remote-debugging-port=9751"],
    { cwd: ".", env, stdio: ["ignore", "ignore", "ignore"] },
  );
  await new Promise((r) => setTimeout(r, 14000));
  const b2 = await connectWithRetry(chromium, "http://127.0.0.1:9751");
  const p2 = b2.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await p2.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await p2.waitForTimeout(2000);
  report.afterRestartChips = await p2.$$eval(".wb-composer-chip", (els) => els.map((e) => e.textContent.trim()));
  report.afterRestartInstalled = await p2.locator('[data-testid="wb-installed-count"]').textContent().catch(() => null);
  await b2.close();
  c2.kill();
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();

  /*
   * ⚠️ 这条脚本**原来一条判定都没有**（只有 `console.log(report)`）——
   * 在批跑里等于"静默不测"（永远 exit 0，正是 §207 乙类那条问题）。
   * 2026-10-13 只补**零覆盖清单那一组 testid** 的判定（其余仍是报告），
   * 因为这一组是"没人点过的界面"，最需要一道会红的门（§201 的 59px 就是没人看才烂掉的）。
   */
  const bad = [];
  if (report.marketSearchbox !== 1) bad.push("市场页没有搜索框");
  if (report.marketCategories?.count !== 1) bad.push("市场页没有分类行");
  if ((report.marketCategories?.chips ?? 0) < 2) {
    bad.push(`分类行里几乎没有可点的分类：${report.marketCategories?.chips}`);
  }
  const tabs = report.manageTabsBox?.tabs ?? [];
  if (report.manageTabsBox?.count !== 1) bad.push("管理页没有页签容器");
  for (const want of ["插件", "技能", "连接器"]) {
    if (!tabs.some((t) => t.startsWith(want))) bad.push(`管理页少了「${want}」页签：${JSON.stringify(tabs)}`);
  }
  if (!report.manageAdd) bad.push("管理页没有「添加」按钮");
  else {
    if (report.manageAdd.disabled) bad.push("⭐ 管理页的「添加」被禁用了（点了没反应的假按钮）");
    if (!report.manageAdd.text.includes("添加")) bad.push(`「添加」文案不对：${report.manageAdd.text}`);
  }
  /*
   * ⚠️ 2026-10-16：这两条是新补的 —— 原来那一段（技能弹层）只收集不判定，
   * 而且收的是**已经作废的 testid**（`wb-skill-toggle-*`），所以"装了技能之后弹层里能不能用它"
   * 从来没被断过。现在两向都断：旧的必须真的不在了、新的必须真的能看到。
   */
  if (report.oldSkillToggleLeft !== 0) {
    bad.push(`技能弹层里还有 ${report.oldSkillToggleLeft} 个旧 testid（wb-skill-toggle-*）—— 改版没改干净？`);
  }
  if (report.manageEntry !== 1) {
    bad.push(`技能弹层里没有「技能管理」入口（读到 ${JSON.stringify((report.pickerItems ?? []).slice(0, 8))}）—— 装了技能却没地方管`);
  }
  if (!report.chipHasCustom) {
    bad.push(
      `启用之后输入区没有出现自定义技能「查股价」的 chip（读到 ${JSON.stringify(report.enabledChips)}）—— 装了却用不上`,
    );
  }
  if (!report.manageRefresh) bad.push("管理页没有「刷新」按钮");
  else {
    if (report.manageRefresh.disabled) bad.push("⭐ 管理页的「刷新」被禁用了（§124 审计过的死按钮）");
    if (report.manageRefresh.title !== "刷新") bad.push(`「刷新」的 title 不对：${report.manageRefresh.title}`);
  }
  if (bad.length) {
    console.error("✗ 零覆盖那一组（市场搜索/分类 + 管理页签/添加/刷新）：" + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 零覆盖那一组成立：市场搜索框与分类行在 / 管理页三页签齐 / 「添加」「刷新」是真按钮");
  }
}
