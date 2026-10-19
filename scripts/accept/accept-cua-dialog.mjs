import { chromium } from "playwright";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**CUA 的确认框是应用内的、长得像产品**（2026-10-19）。
 *
 * ## 为什么单开一条
 *
 * 主人第一版看到的是**系统原生弹窗**（"太硬核了"），第二版是**整页白板**
 * （复用了整页设置视图的样式）。两次都只有真人截图才看得见 —— 没有测试盯着它长什么样。
 *
 * 这条就盯三件事：
 * 1. 弹窗**在 DOM 里**（`[data-testid=wb-confirm-dialog]`），不是 OS 窗口；
 * 2. 它是**居中的模态**：遮罩铺满、卡片窄于视口且居中（不是 `inset:0` 的整页）；
 * 3. 默认焦点在「取消」（安全闸的默认答案必须是否定的）。
 */
const DATA = ".verify/cua-ui-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const PORT = 9383;
const out = {};
let child = null;

try {
  const boot = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = boot.child;
  if (!boot.ok) throw new Error("启动失败：" + (boot.getLog() || "").slice(-800));
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(browser);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  /* 触发授权确认（它以前是原生弹窗，现在应该是 DOM 里的框） */
  const enable = page.evaluate(async () => globalThis.shell.computer.enable());

  const dialog = page.locator('[data-testid="wb-confirm-dialog"]');
  await dialog.waitFor({ timeout: 15000 });
  out.inDom = true;

  const card = page.locator(".wb-modal");
  const box = await card.boundingBox();
  /* ⚠️ 真 Electron 窗口里  是 null —— 要从页面自己取 */
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  out.cardBox = box;
  out.viewport = viewport;
  /* 居中 + 不是整页：卡片宽度明显小于视口，且左右留白接近 */
  const centered =
    box !== null &&
    box.width < viewport.width * 0.95 &&
    Math.abs(box.x - (viewport.width - box.width - box.x)) < 80 &&
    box.height < viewport.height * 0.95;
  out.centered = centered;

  /* 遮罩铺满 */
  const maskBox = await dialog.boundingBox();
  out.maskCovers = maskBox !== null && maskBox.width >= viewport.width - 2 && maskBox.height >= viewport.height - 2;

  /* 默认焦点在取消 */
  out.focusIsCancel = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "wb-confirm-cancel");

  /* 文案在 DOM 里（可被验收看见） */
  out.messageText = (await page.locator('[data-testid="wb-confirm-message"]').textContent()) ?? "";

  await shot(page, ".verify/cua-confirm-dialog.png");

  /* Esc = 取消：授权必须失败 */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const result = await enable;
  out.escCancels = result?.ok === false;
  out.dialogGone = (await dialog.count()) === 0;
} finally {
  if (child) await killTree(child);
}

const checks = [
  ["确认框在 DOM 里（不是系统原生弹窗）", out.inDom === true],
  ["遮罩铺满视口", out.maskCovers === true],
  ["卡片居中且窄于视口（不是整页白板）", out.centered === true],
  ["默认焦点在「取消」（安全默认）", out.focusIsCancel === true],
  ["说明文案在 DOM 里（验收看得见）", String(out.messageText).includes("截屏")],
  ["Esc 等于取消（授权没生效）", out.escCancels === true],
  ["取消后弹窗消失", out.dialogGone === true],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}\n`);
}
process.stdout.write("\n" + JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`\n${failed === 0 ? "✓ 全部通过" : `✗ ${failed} 项未通过`}（${checks.length} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
