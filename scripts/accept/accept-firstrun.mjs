import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
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
 * 验收：**首跑默认态**（P0-08 / §7 场景 5）。
 *
 * ## 判据（全是行为）
 *
 * - 数据目录里没有 pinnedModel、但有可用 key → 首跑向导**出现**，
 *   并且**直接落在第 3 步「选模型」**（第 1 步已自动跳过，不要求重新填 key）；
 * - 选一个模型 → 走完向导 → 首页的模型 chip 显示**那个模型**（不是"自动选择"）；
 * - 上下文表显示**按窗口推导的预算**（不是"自动选择（未记录）"）；
 * - 首屏默认身份是**编码**（首页模式 chip）。
 *
 * 不调模型、不出网（只读本机凭据判断"有没有 key"）。
 */
const DATA = ".verify/firstrun-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const PORT = 9381;
const out = {};
let child = null;

try {
  /*
   * M-02（2026-10-21）：向导"已有 key 就跳过填 key"的判据从 `available` 改成了
   * `configured`（= 本应用存的）。批跑环境里 `STRATA_API_KEY` **是环境变量**，
   * 那属于"能用但不是你配的" —— 向导会停在填 key 那一步并给"存一份到本应用"的快捷路径
   * （那条路径由 `providerBadge.test.ts` + `accept-key-source.mjs` 盯着）。
   * 这条脚本要验的是**已配置**那一支，所以：
   *   ① 把环境变量那格清空；
   *   ② **自己**往 `DSH_CREDENTIALS_FILE` 写一条 —— 不依赖批跑有没有写成
   *      （CI 的干净检出里 `.verify/` 不存在时，批跑那次写曾经静默失败过）。
   */
  const credFile = process.env.DING_CREDENTIALS_FILE?.trim();
  if (credFile) {
    fs.mkdirSync(path.dirname(credFile), { recursive: true });
    fs.writeFileSync(credFile, "refs:\n  STRATA_API_KEY: accept-app-saved-key\n", "utf8");
  }
  const booted = await bootApp({
    port: PORT,
    dataDir: DATA,
    timeoutMs: 30000,
    extraEnv: { STRATA_API_KEY: "" },
  });
  child = booted.child;
  if (!booted.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (booted.getLog() || "(空)").slice(-1200));
    process.exit(1);
  }
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  /* 这条**就是要验向导**：别让 harness 替我们点掉它 */
  const page = await waitForPage(browser, 20000, { keepFirstRun: true });
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  /* 首跑向导出现 */
  const guide = page.locator('[data-testid="wb-firstrun"]');
  await guide.waitFor({ timeout: 15000 }).catch(() => undefined);
  out.guideVisible = (await guide.count()) > 0;
  if (!out.guideVisible) throw new Error("有 key、没有 pinnedModel，首跑向导却没有出现");

  /* 落在「选模型」那一步（第 3 个 li），第 1 步已标记 done */
  const steps = page.locator(".wb-firstrun-steps > li");
  out.stepCount = await steps.count();
  out.modelStepActive = (await steps.nth(2).getAttribute("data-active")) === "true";
  out.providerStepDone = (await steps.nth(0).getAttribute("data-done")) === "true";
  out.modelSelectVisible = (await page.locator('[data-testid="wb-firstrun-model"]').count()) > 0;
  if (!out.modelStepActive) throw new Error("向导没有落在「选模型」那一步（有 key 时第 1 步应被跳过）");

  /*
   * F-01：**首屏只留一个主动作** —— 向导显示期间首页主体不渲染。
   * （旧行为是"向导在上、首页在下"并列，首屏 31 个可点元素在两个主动作之间抢注意力。）
   */
  const shell = page.locator('[data-testid="wb-home-shell"]');
  out.shellVisible = (await shell.count()) > 0;
  out.homeHiddenWhileGuide = (await page.locator('[data-testid="wb-home"]').count()) === 0;
  const cardBox = await guide.locator(".wb-firstrun-card").boundingBox();
  out.guideHeight = cardBox ? Math.round(cardBox.height) : 0;
  out.guideCardVisible = out.guideHeight > 0;
  /* 向导开着时的样子（证据：给人看的，不是断言） */
  await shot(page, ".verify/firstrun-guide.png");

  /*
   * F-01 的逃生门：「稍后再说」→ 设置 → 通用 → 重新运行配置向导 → 向导回来。
   * 缺陷形状：旧版点一次就写死"永不出现"，设置里没有重开入口。
   */
  await page.locator('[data-testid="wb-firstrun-skip"]').click();
  await page.waitForTimeout(800);
  out.skipShowsHome = (await page.locator('[data-testid="wb-home"]').count()) === 1;
  out.skipHidesGuide = (await page.locator('[data-testid="wb-firstrun"]').count()) === 0;

  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-set-通用"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-setpage-reopen-guide"]').click();
  await page.waitForTimeout(1200);
  out.reopenShowsGuide = (await page.locator('[data-testid="wb-firstrun"]').count()) === 1;
  out.reopenHidesHome = (await page.locator('[data-testid="wb-home"]').count()) === 0;
  if (out.reopenShowsGuide) await shot(page, ".verify/firstrun-reopened.png");

  /* 选一个模型并走完 */
  const select = page.locator('[data-testid="wb-firstrun-model"]');
  const values = await select.locator("option").evaluateAll((els) =>
    els.map((e) => e.value).filter(Boolean),
  );
  out.modelChoices = values.length;
  if (!values.length) throw new Error("选模型那一步没有任何可选模型");
  const picked = values[0];
  await select.selectOption(picked);
  await page.locator('[data-testid="wb-firstrun-model-next"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-firstrun-finish"]').click();
  await page.waitForTimeout(1200);
  out.guideGone = (await page.locator('[data-testid="wb-firstrun"]').count()) === 0;

  /* 首页 chip 显示的是钉住的模型 */
  const chipText = (await page.locator('[data-testid="wb-model"]').innerText()).trim();
  out.chipText = chipText;
  out.chipShowsPicked = chipText.includes(picked);
  out.chipNotAuto = !chipText.includes("自动选择");

  /* 上下文表：按窗口推导的预算（不是"未记录"） */
  const meter = page.locator('[data-testid="wb-context-meter"]');
  out.meterText = (await meter.count()) ? (await meter.innerText()).trim() : "";
  /* T-07：首页只说窗口额度（`模型窗口 966k token 可用`），不再显示上一段会话的用量 */
  out.meterHasBudget = /模型窗口\s*\d+(\.\d+)?(k|M)\s*token\s*可用/.test(out.meterText);
  out.meterNotUnknown = !out.meterText.includes("未记录");

  /* 首屏默认身份：编码（C-01 起当前模式是静态标签，用 aria-current） */
  const codingPressed = await page
    .locator('[data-testid="wb-home-mode-coding"]')
    .getAttribute("aria-pressed")
    .catch(() => null);
  const codingCurrent = await page
    .locator('[data-testid="wb-home-mode-coding"]')
    .getAttribute("aria-current")
    .catch(() => null);
  out.homeMode = codingPressed === "true" || codingCurrent === "true" ? "编码" : "非编码";
  out.defaultCoding = codingPressed === "true" || codingCurrent === "true";

  await shot(page, ".verify/firstrun.png");
} catch (error) {
  out.error = error instanceof Error ? error.message : String(error);
} finally {
  await killTree(child);
}

const checks = [
  ["有 key、没 pinnedModel → 首跑向导出现", out.guideVisible === true],
  ["向导直接落在「选模型」这一步", out.modelStepActive === true],
  ["第 1 步（填 key）被跳过", out.providerStepDone === true],
  ["模型下拉有可选项", (out.modelChoices ?? 0) > 0],
  ["选完并走完向导后向导消失", out.guideGone === true],
  ["首页模型 chip 显示刚选的那个模型", out.chipShowsPicked === true],
  ["模型 chip 不再写「自动选择」", out.chipNotAuto === true],
  ["上下文表显示按窗口推导的预算", out.meterHasBudget === true],
  ["上下文表不写「未记录」", out.meterNotUnknown === true],
  ["首屏默认身份是编码", out.defaultCoding === true],
  ["首页外壳存在", out.shellVisible === true],
  ["⭐ 向导显示期间首页主体不渲染（首屏只有一个主动作）", out.homeHiddenWhileGuide === true],
  ["向导卡片真的画出来了", out.guideCardVisible === true],
  ["⭐「稍后再说」之后首页回来、向导消失", out.skipShowsHome === true && out.skipHidesGuide === true],
  ["⭐ 设置 → 通用 → 重新运行配置向导：向导回来", out.reopenShowsGuide === true],
  ["重开之后首页主体再次让位", out.reopenHidesHome === true],
];

if (out.error) process.stdout.write(`\n异常：${out.error}\n`);
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
process.stdout.write("\n" + JSON.stringify(out, null, 2) + "\n");
process.stdout.write(
  `\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（${checks.length} 项：首跑落点 / 模型显示 / 预算 / 默认身份）\n`,
);
process.exit(failed === 0 ? 0 : 1);
