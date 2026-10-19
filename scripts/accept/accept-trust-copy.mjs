import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

import { NO_PAGE_HINT, bootApp, connectWithRetry, expandComposerMore, freshDir, killTree, waitForPage } from "./harness.mjs";

/**
 * 验收 T-11 / T-12 / T-13 / T-14 / T-15 + T-16 的三条复现（**不调模型**）。
 *
 * 判据全是页面上的**可见文案**（这四条修的就是"说法"而不是机制）：
 *
 * - T-11：手机遥控页有统一的「本机版不可用」说明块；
 * - T-12：三处「用量」各自写清范围（本段对话 / 最近 90 天 / 团队账本）；
 * - T-13：团队空间把"名册文件"与"成本来源"拆成两行；
 * - T-14：插件页没有编造的"N 万人在用"；
 * - T-15：权限页改成用户语言（不再写"角色是上限，档位是旋钮"）；
 * - T-16：①顶部搜索能输入并出结果；②连续 3 次启动左栏都在；③定时任务 ▶ 点后有反馈。
 */
const DATA = ".verify/trust-copy-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录删不掉");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });
/* 空凭据：让定时任务 ▶ 的 createTask 快速失败 —— 我们要验的是"点后有反馈"，不是模型 */
const EMPTY_KEYS = ".verify/trust-copy-empty-keys.yaml";
fs.writeFileSync(EMPTY_KEYS, "refs:\n", "utf8");

/* T-16③ 的夹具：一条定时任务（▶ 点下去必须**无论如何都给一行反馈**） */
fs.writeFileSync(
  path.join(DATA, "schedules.json"),
  JSON.stringify({
    __schema: 1,
    data: [
      {
        id: "job-feedback",
        title: "反馈测试",
        prompt: "说一句 ok",
        repeat: "daily",
        atHour: 9,
        status: "running",
        createdAt: Date.now() - 60_000,
        lastRunAt: null,
        nextRunAt: Date.now() + 86_400_000,
        runs: [],
      },
    ],
  }),
  "utf8",
);

const out = { boots: [] };
let child = null;

async function bootAt(port, extraEnv = {}) {
  const booted = await bootApp({ port, dataDir: DATA, timeoutMs: 30000, extraEnv });
  if (!booted.ok) throw new Error("应用没起来：" + (booted.getLog() || "").slice(-600));
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${port}`);
  const page = await waitForPage(browser);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1200);
  return { booted, browser, page };
}

try {
  /* ── T-16②：连续 3 次启动，左栏都要在（1/3 不渲染的复现） ── */
  for (let i = 0; i < 3; i += 1) {
    const { booted, browser, page } = await bootAt(9471 + i);
    const nav = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="wb-nav"]');
      if (!el) return { found: false, width: 0, items: 0 };
      const r = el.getBoundingClientRect();
      return { found: true, width: Math.round(r.width), items: document.querySelectorAll('[data-testid^="wb-nav-"]').length };
    });
    out.boots.push(nav);
    await browser.close().catch(() => undefined);
    await killTree(booted.child);
    await new Promise((r) => setTimeout(r, 800));
  }
  out.navAlwaysRendered = out.boots.every((b) => b.found && b.width >= 200 && b.items >= 5);

  /* ── 主实例：其它文案与交互 ── */
  const { booted, browser, page } = await bootAt(9481, { DSH_CREDENTIALS_FILE: path.resolve(EMPTY_KEYS) });
  child = booted.child;

  /* T-16①：顶部搜索能输入并出结果列表 */
  /* 搜索是**按钮开后**才出输入框（WorkBuddy 那次很可能只点了图标、没看到展开） */
  await page.locator('[data-testid="wb-search"]').click();
  await page.waitForTimeout(400);
  const search = page.locator('[data-testid="wb-navsearch-input"]');
  out.searchVisible = (await search.count()) > 0;
  if (out.searchVisible) {
    await search.click();
    await search.fill("测试");
    await page.waitForTimeout(800);
    out.searchListVisible = (await page.locator('[data-testid="wb-navsearch-list"]').count()) > 0;
    /* 搜索展开时会盖住左栏导航 —— 验完收起来，否则后面的点击全被它挡住 */
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  /* T-16③：定时任务 ▶ 点下去之后，界面上必须出现一行反馈（成功或失败都算） */
  await page.locator('[data-testid="wb-nav-scheduled"]').click();
  await page.waitForTimeout(800);
  const runBtn = page.locator('[data-testid="wb-job-run-job-feedback"]');
  out.runBtnFound = (await runBtn.count()) > 0;
  if (out.runBtnFound) {
    await runBtn.click();
    /* 反馈文案先出现"正在执行…"，失败后变成"执行失败…" —— 两者都算有反馈 */
    await page
      .locator('[data-testid="wb-sched-note"]')
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    /*
     * ▶ 是**前台执行**：它会跳到任务页（这本身就是反馈），
     * 失败时任务页里写着原因。所以两种都算"点下去有反应"：
     * 留在本页出现 note，或已经切到任务页。
     */
    await page.waitForTimeout(4000);
    out.scheduleNote = (await page.locator('[data-testid="wb-sched-note"]').first().innerText().catch(() => "")).trim();
    out.scheduleJumped = (await page.locator('[data-testid="wb-task"]').count()) > 0;
    out.scheduleTaskText = (await page.locator('[data-testid="wb-task"]').first().innerText().catch(() => "")).slice(0, 200);
  }

  /*
   * T-11：手机遥控页的统一说明块。
   * C-01（2026-10-20）把它从主导航**移进了设置** —— 本机不可用，不该占主导航。
   */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForSelector('[data-testid="wb-set-手机遥控电脑"]', { timeout: 5000 });
  await page.locator('[data-testid="wb-set-手机遥控电脑"]').click();
  await page.waitForTimeout(700);
  out.phoneLocalOnly = (await page.locator('[data-testid="wb-phone-localonly"]').innerText().catch(() => "")).trim();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  /* T-11：终端页标题改成「命令记录（只读）」 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(400);
  /* 终端入口在左栏导航 */
  const termNav = page.locator('[data-testid="wb-nav-terminal"]');
  out.terminalNavFound = (await termNav.count()) > 0;
  if (out.terminalNavFound) {
    await termNav.click();
    await page.waitForTimeout(700);
    out.terminalTitle = (await page.locator('[data-testid="wb-terminal-page"] b').first().innerText().catch(() => "")).trim();
  }

  /* T-12：输入区用量 chip 写「本段对话」 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  /* C-01：用量 chip 收在首页的「更多」后面 */
  await expandComposerMore(page);
  out.usageChip = (await page.locator('[data-testid="wb-usage"]').innerText().catch(() => "")).trim();

  /* T-12 / T-15：用量页与权限页（用左栏入口） */
  await page.locator('[data-testid="wb-nav-usage"]').click();
  await page.waitForTimeout(800);
  out.insightsUsageTab = (await page.locator('[data-testid="wb-insights-usage-tab"]').innerText().catch(() => "")).trim();

  await page.locator('[data-testid="wb-nav-permissions"]').click();
  await page.waitForTimeout(800);
  out.permPlain = (await page.locator('[data-testid="wb-perm-plain"]').innerText().catch(() => "")).trim();
  out.permOldWording = (await page.locator('[data-testid="wb-perm-plain"]').count())
    ? (await page.content()).includes("角色是上限，档位是旋钮")
    : null;

  /* T-11：账号菜单里的额度说明 */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(500);
  out.accountQuota = (await page.locator('[data-testid="wb-acct-quota"]').innerText().catch(() => "")).trim();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* T-13 / T-14：设置 → 团队空间 / 插件页 */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);
  await page.locator('[data-testid="wb-set-团队空间"]').click();
  await page.waitForTimeout(900);
  out.teamRoster = (await page.locator('[data-testid="wb-team-roster-file"]').innerText().catch(() => "")).trim();
  out.teamCostSource = (await page.locator('[data-testid="wb-team-cost-source"]').innerText().catch(() => "")).trim();
  out.teamLocalOnly = (await page.locator('[data-testid="wb-team-localonly"]').innerText().catch(() => "")).trim();

  /* 返回设置根再进插件页（T-14） */
  await page.locator('[data-testid="wb-set-crumb-root"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-set-插件·技能·伙伴"]').click();
  await page.waitForTimeout(1000);
  const pluginText = await page.locator('[data-testid="wb-set-panel"]').innerText().catch(() => "");
  out.pluginHasFakeCounts = /万人在用|人在用/.test(pluginText);
  out.installedCountShown = /已安装\s*\d+\s*个/.test(pluginText);

  await page.screenshot({ path: ".verify/trust-copy.png" });
  await browser.close().catch(() => undefined);
} catch (error) {
  out.error = error instanceof Error ? error.message : String(error);
} finally {
  await killTree(child);
}

const checks = [
  ["T-16② 连续 3 次启动左栏都渲染出来（宽 ≥200）", out.navAlwaysRendered === true],
  ["T-16① 顶部搜索输入框在，能出结果列表", out.searchVisible === true && out.searchListVisible === true],
  ["T-16③ 定时任务 ▶ 点下去有反馈（note 或跳到任务页）", out.runBtnFound === true && (Boolean(out.scheduleNote) || out.scheduleJumped === true)],
  ["T-11 手机遥控页有统一的本机版说明", out.phoneLocalOnly?.includes("手机遥控需要配套手机端")],
  ["T-11 终端页标题改成「命令记录（只读）」", out.terminalTitle?.includes("命令记录（只读）")],
  ["T-11 账号菜单额度写明「本机版没有额度体系」", out.accountQuota?.includes("本机版没有额度体系")],
  ["T-12 输入区用量 chip 写「本段对话」", out.usageChip?.includes("本段对话")],
  ["T-12 用量页标注「最近 90 天」", out.insightsUsageTab?.includes("最近 90 天")],
  ["T-13 团队空间拆出「名册与口令」一行", out.teamRoster?.includes("名册与口令")],
  ["T-13 团队空间写明成本来自 sessions.db", out.teamCostSource?.includes("sessions.db")],
  ["T-11 团队空间有统一的本机版说明", out.teamLocalOnly?.includes("本机数据 + 配对码")],
  ["T-14 插件页不再出现编造的人数", out.pluginHasFakeCounts === false],
  ["T-14 插件页显示「已安装 N 个」", out.installedCountShown === true],
  ["T-15 权限页改成用户语言（旧措辞已去掉）", out.permOldWording === false],
  ["T-15 权限页说清「点这一档会发生什么」", out.permPlain?.includes("点某个档位之后")],
];

if (out.error) process.stdout.write(`\n异常：${out.error}\n`);
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
process.stdout.write("\n" + JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（${checks.length} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
