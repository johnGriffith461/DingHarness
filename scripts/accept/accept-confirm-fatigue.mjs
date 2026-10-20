import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import {
  NO_PAGE_HINT,
  bootApp,
  connectWithRetry,
  freshDir,
  killTree,
  shot,
  waitForPage,
} from "./harness.mjs";

/**
 * F-04（2026-10-20）：**确认疲劳的逃生门 + 总是允许规则可撤销**。
 *
 * 两段都做真机：
 * 1. 预置一段"已经问过 2 次编辑、第 3 次待批"的任务 → 打开它 → 出现逃生门 →
 *    点「本会话自动接受」→ 档位变「接受编辑」但 **localStorage 没变**；
 *    重启应用 → 档位回到「按需确认」（按钮上写的是"本会话"，不能骗人）。
 * 2. 预置两条「总是允许」规则 → 设置 → 通用 → 规则表列出它们 → 删一条 → 少一条。
 *
 * 不调模型（任务与规则都是预置的落盘数据；验的是界面与档位语义）。
 */

const DATA = ".verify/confirm-fatigue-data";
const PORT = 9384;
const TASK_ID = "fatigue-probe";
const NOW = Date.now();

if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

const task = {
  id: TASK_ID,
  title: "疲劳探针",
  brief: "预置任务：前两次编辑已批、第三次待批",
  createdAt: NOW - 60_000,
  stage: "awaiting",
  startedAt: NOW - 50_000,
  finishedAt: null,
  steps: [
    {
      id: "s1",
      role: "assistant",
      text: "已经改了两个文件，第三个在等你确认。",
      at: NOW - 40_000,
      tools: [
        { toolCallId: "c1", name: "write_file", ok: true, line: "⚙ 写文件：已写入 a.txt", input: { path: "a.txt" } },
        { toolCallId: "c2", name: "edit_file", ok: true, line: "⚙ 改文件：已改 b.txt", input: { path: "b.txt" } },
        { toolCallId: "c3", name: "write_file", ok: false, line: "⚙ 写文件：等你确认", input: { path: "c.txt" }, pending: true },
      ],
    },
  ],
  questions: [],
  questionIndex: 0,
  activity: "等你确认",
  artifacts: [],
};
/* 落盘走 C1 信封（`{ __schema, data }`）—— 与生产写入口同一个形状 */
fs.writeFileSync(path.join(DATA, "tasks.json"), JSON.stringify({ __schema: 1, data: [task] }, null, 2), "utf8");
fs.writeFileSync(
  path.join(DATA, "settings.json"),
  JSON.stringify(
    {
      __schema: 1,
      data: {
        rules: [
          { action: "run_command", resource: "git status", effect: "allow", expiresAt: NOW + 86_400_000, note: "用户在审批时选了「总是允许」" },
          { action: "write_file", resource: "D:/proj/src/**", effect: "allow", expiresAt: NOW + 86_400_000, note: "用户在审批时选了「总是允许」" },
        ],
      },
    },
    null,
    2,
  ),
  "utf8",
);

const out = {};
let child = null;
let browser = null;

async function openApp() {
  const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = booted.child;
  if (!booted.ok) throw new Error("应用没起来：" + (booted.getLog() || "").slice(-800));
  browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(browser);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return page;
}

try {
  /* ── 第一段：逃生门 ── */
  let page = await openApp();
  await page.locator(`[data-testid="wb-recent-${TASK_ID}"]`).click();
  await page.waitForTimeout(800);
  out.fatigueVisible = (await page.locator('[data-testid="wb-confirm-fatigue"]').count()) === 1;
  out.fatigueText = out.fatigueVisible
    ? (await page.locator('[data-testid="wb-confirm-fatigue"]').innerText()).replace(/\s+/g, " ").trim()
    : "";
  await shot(page, ".verify/confirm-fatigue.png");

  if (out.fatigueVisible) {
    await page.locator('[data-testid="wb-bulk-accept"]').click();
    await page.waitForTimeout(900);
  }
  out.confirmChipAfter = (await page.locator('[data-testid="wb-confirm"]').innerText()).trim();
  out.modeChanged = out.confirmChipAfter.includes("接受编辑");
  out.persistedMode = await page.evaluate(() => localStorage.getItem("dsh-canvas.confirm-mode"));
  out.sessionOnly = out.persistedMode === null;

  await browser.close();
  await killTree(child);
  child = null;

  /* ── 重启：档位必须回到默认（"本会话"效力） ── */
  page = await openApp();
  /* 重开时没有 pinnedModel → 首跑向导可能挡在首页；先让开，再打开那段任务读 chip */
  if ((await page.locator('[data-testid="wb-firstrun"]').count()) === 1) {
    await page.locator('[data-testid="wb-firstrun-skip"]').click();
    await page.waitForTimeout(800);
  }
  await page.locator(`[data-testid="wb-recent-${TASK_ID}"]`).click();
  await page.waitForTimeout(800);
  out.confirmChipAfterRestart = (await page.locator('[data-testid="wb-confirm"]').innerText()).trim();
  out.backToDefault = out.confirmChipAfterRestart.includes("按需确认");

  /* ── 第二段：规则表可看可删 ── */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-set-通用"]').click();
  await page.waitForTimeout(700);
  out.rulesCountText = (await page.locator('[data-testid="wb-rules-count"]').innerText()).trim();
  out.ruleRowsBefore = await page.locator(".wb-rule-row").count();
  await shot(page, ".verify/confirm-rules.png");
  await page.locator('[data-testid="wb-rule-remove-run_command|git status|allow"]').click();
  await page.waitForTimeout(900);
  out.ruleRowsAfter = await page.locator(".wb-rule-row").count();

  await browser.close();
} catch (error) {
  out.error = error instanceof Error ? error.message : String(error);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await killTree(child);
}

const checks = [
  ["第 3 次待批编辑 → 出现逃生门", out.fatigueVisible === true],
  ["逃生门写明已问了几次、命令仍会问", out.fatigueText?.includes("3 次") === true && out.fatigueText?.includes("命令仍会问") === true],
  ["点「本会话自动接受」→ 档位变接受编辑", out.modeChanged === true],
  ["⭐ 但 localStorage 没被写（按钮承诺的是本会话）", out.sessionOnly === true],
  ["重启之后档位回到「按需确认」", out.backToDefault === true],
  ["设置里列出两条「总是允许」规则", out.ruleRowsBefore === 2],
  ["删一条之后规则少一条", out.ruleRowsAfter === 1],
];

if (out.error) process.stdout.write(`\n异常：${out.error}\n`);
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
process.stdout.write("\n" + JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（${checks.length} 项：确认疲劳逃生门 / 规则表）\n`);
process.exit(failed === 0 ? 0 : 1);
