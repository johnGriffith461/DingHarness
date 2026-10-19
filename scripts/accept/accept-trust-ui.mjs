import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收 T-04 / T-05 / T-06 / T-07（**不调模型**：这四条都是界面行为）。
 *
 * ① T-04 记忆「全部清除」：先出确认框，取消后条数不变，确认后才清空；
 * ② T-05 设置左栏「记忆」→ 右侧主面板真的切到记忆页（不是停在模型页）；
 * ③ T-06 档位弹层：三个选项里**只有一个勾**；
 * ④ T-07 首页计量：不显示上一段任务的用量，只说模型窗口额度；
 *    任务页仍显示真实用量。
 *
 * 数据：独立数据目录 + 种一条带 usage 的任务（文件后端）。
 */
const DATA = ".verify/trust-ui-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });
/* 种一条"上一段任务"，带 usage —— 用来验首页不回显它 */
const tasks = [
  {
    id: "t-prev",
    title: "上一段任务",
    brief: "旧任务",
    createdAt: Date.now() - 60_000,
    stage: "done",
    startedAt: Date.now() - 59_000,
    finishedAt: Date.now() - 58_000,
    steps: [
      { id: "s1", role: "user", text: "旧问题", at: Date.now() - 60_000 },
      {
        id: "s2",
        role: "assistant",
        text: "旧回答",
        at: Date.now() - 59_000,
        usage: { inputTokens: 43_000, outputTokens: 1_200 },
      },
    ],
    questions: [],
    questionIndex: 0,
    activity: "",
    artifacts: [],
  },
];
fs.writeFileSync(path.join(DATA, "tasks.json"), JSON.stringify(tasks), "utf8");
/* 记忆里种两条：清空确认要能看出"取消后还在" */
fs.writeFileSync(
  path.join(DATA, "memory.json"),
  JSON.stringify({ __schema: 1, data: { entries: [{ id: "m1", text: "记住第一条", at: 1 }, { id: "m2", text: "记住第二条", at: 2 }] } }),
  "utf8",
);
fs.writeFileSync(
  path.join(DATA, "settings.json"),
  JSON.stringify({ __schema: 1, data: { pinnedModel: "deepseek/deepseek-chat" } }),
  "utf8",
);

const PORT = 9461;
const out = {};
let child = null;

try {
  const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = booted.child;
  if (!booted.ok) {
    console.error("[诊断] " + (booted.getLog() || "").slice(-1000));
    process.exit(1);
  }
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(browser);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  /* ── ④ T-07 首页计量 ── */
  out.homeMeter = (await page.locator('[data-testid="wb-context-meter"]').innerText()).trim();
  out.homeMeterHasOldUsage = /43(\.0)?k|44k/.test(out.homeMeter);
  out.homeMeterIsWindow = /模型窗口/.test(out.homeMeter);

  /* ── ③ T-06 档位弹层 ── */
  await page.locator('[data-testid="wb-composer-input"]').click();
  /* 档位 chip 的 testid：找带"按需确认"的那个 */
  const modeChip = page.locator('[data-testid="wb-confirm"]').first();
  out.modeChipFound = (await modeChip.count()) > 0;
  if (out.modeChipFound) {
    await modeChip.click();
    await page.waitForTimeout(400);
    out.checkIcons = await page.locator('[class*="wb-chip-pop"] svg.lucide-check, [class*="wb-chip-pop"] .lucide-check').count();
    out.checkedOptions = await page.locator('[role="menuitemradio"][aria-checked="true"]').count();
    out.radioOptions = await page.locator('[role="menuitemradio"]').count();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  /* ── ② T-05 设置 → 记忆 ── */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(900);
  const pages = page.locator('[data-testid^="wb-set-item-"]');
  out.settingsRows = await pages.count();
  const memRow = page.locator('[data-testid="wb-set-记忆"]');
  if (!(await memRow.count())) {
    /* 兜底：按文本找 */
    await page.getByText("记忆", { exact: true }).first().click();
  } else {
    await memRow.click();
  }
  await page.waitForTimeout(900);
  out.memoryPageVisible = (await page.locator('[data-testid="wb-setpage-memory"]').count()) > 0;
  out.modelPageStillVisible = (await page.locator('[data-testid="wb-setpage-models"]').count()) > 0;

  /* ── ① T-04 清空确认 ── */
  const clearBtn = page.locator('[data-testid="wb-memory-clear"]');
  out.clearBtnVisible = (await clearBtn.count()) > 0;
  if (out.clearBtnVisible) {
    await clearBtn.click();
    await page.waitForTimeout(400);
    out.confirmVisible = (await page.locator('[data-testid="wb-confirm-dialog"]').count()) > 0;
    out.confirmText = await page
      .locator('[data-testid="wb-confirm-dialog"]')
      .first()
      .innerText()
      .catch(() => "");
    /* 取消：条数必须不变 */
    const cancel = page.locator('[data-testid="wb-confirm-cancel"]').first();
    if (await cancel.count()) await cancel.click();
    await page.waitForTimeout(500);
    out.entriesAfterCancel = await page.locator('[data-testid^="wb-memory-drop-"]').count();
    /* 再点一次并确认 */
    await clearBtn.click();
    await page.waitForTimeout(400);
    const ok = page.locator('[data-testid="wb-confirm-ok"]').first();
    if (await ok.count()) await ok.click();
    await page.waitForTimeout(900);
    out.entriesAfterConfirm = await page.locator('[data-testid^="wb-memory-drop-"]').count();
  }
  await shot(page, ".verify/trust-ui.png");
} catch (error) {
  out.error = error instanceof Error ? error.message : String(error);
} finally {
  await killTree(child);
}

const checks = [
  ["T-07 首页计量不显示上一段任务的用量", out.homeMeterHasOldUsage === false],
  ["T-07 首页计量说清「模型窗口」", out.homeMeterIsWindow === true],
  ["T-06 档位 chip 找得到", out.modeChipFound === true],
  ["T-06 三个选项都有 radio 语义", out.radioOptions === 3],
  ["T-06 只有一个选项被标记为选中", out.checkedOptions === 1],
  ["T-06 弹层里只有一个勾图标", out.checkIcons === 1],
  ["T-05 设置里点「记忆」→ 右侧是记忆页", out.memoryPageVisible === true],
  ["T-05 点「记忆」后没有残留模型页", out.modelPageStillVisible === false],
  ["T-04 「全部清除」按钮在", out.clearBtnVisible === true],
  ["T-04 点清空前先出现确认框", out.confirmVisible === true],
  ["T-04 确认文案写清条数与不可撤销", /2 条/.test(out.confirmText) && /不可撤销/.test(out.confirmText)],
  ["T-04 取消后条目还在（2 条）", out.entriesAfterCancel === 2],
  ["T-04 确认后真的清空（0 条）", out.entriesAfterConfirm === 0],
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
