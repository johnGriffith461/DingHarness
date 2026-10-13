import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 11.26 验收：手机遥控电脑页的两个开关是**真状态**。
 *
 * 关键断言是**跨重启**：
 *   · 「可被同账号设备连接与控制」是**许可** → 关掉后重启仍是关的（写盘）；
 *   · 「让这台设备保持唤醒状态」是这台机器的**真实状态** → 由主进程
 *     `powerSaveBlocker` 持有，重启后应回到"关"（没有人在阻止休眠了）。
 *
 * 原来两个都是渲染进程里的 useState —— 重启回到默认值，用户会以为"设了没用"。
 */
const DATA = "D:/DoubaoWorkClone/.verify/phone-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const EXE = "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe";

async function launch(port) {
  const child = spawn(EXE, [".", `--remote-debugging-port=${port}`], {
    cwd: "D:/DoubaoWorkClone",
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise((r) => setTimeout(r, 8000));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { child, browser, page };
}

const report = {};
const shots = "D:/DoubaoWorkClone/.verify/shots-final";
let { child, browser, page } = await launch(9660);

try {
  await page.locator('[data-testid="wb-nav-phone"]').click();
  await page.waitForTimeout(1800);

  // 默认：许可开、唤醒关（与实机截图一致）
  report.defaultConnect = await page.locator('[data-testid="wb-switch-connect"]').getAttribute("aria-pressed");
  report.defaultAwake = await page.locator('[data-testid="wb-switch-awake"]').getAttribute("aria-pressed");

  // 页面的关键文案（照实机）
  report.title = await page.locator(".wb-page-h2").textContent();
  report.eyebrow = await page.locator(".wb-mini-label").textContent();
  report.stepTexts = await page.$$eval(".wb-step b", (els) => els.map((e) => e.textContent));
  report.footerTipGone = (await page.locator(".wb-tip").count()) === 0;
  report.qrHonest = await page.locator('[data-testid="wb-qr-unavailable"]').textContent();
  report.mockRows = await page.$$eval(".wb-mock-menu-row", (els) => els.map((e) => e.textContent.trim()));
  report.mockPrompts = await page.$$eval(".wb-mock-prompt", (els) => els.map((e) => e.textContent));
  await page.screenshot({ path: path.join(shots, "wb-24-phone.png") });

  /* ---------- 保持唤醒：主进程真的在拦休眠 ---------- */
  await page.locator('[data-testid="wb-switch-awake"]').click();
  await page.waitForTimeout(1200);
  report.awakeAfterClick = await page.locator('[data-testid="wb-switch-awake"]').getAttribute("aria-pressed");
  report.statusAfterOpen = await page.evaluate(() => window.shell.remote.status());

  /* ---------- 许可：关掉，写盘 ---------- */
  await page.locator('[data-testid="wb-switch-connect"]').click();
  await page.waitForTimeout(1200);
  report.connectAfterClick = await page.locator('[data-testid="wb-switch-connect"]').getAttribute("aria-pressed");
  const remoteFile = path.join(DATA, "remote.json");
  report.remoteJson = fs.existsSync(remoteFile) ? JSON.parse(fs.readFileSync(remoteFile, "utf8")) : null;

  /* ---------- 重启：许可保持关、唤醒回到关 ---------- */
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2500));

  ({ child, browser, page } = await launch(9661));
  await page.locator('[data-testid="wb-nav-phone"]').click();
  await page.waitForTimeout(2000);
  report.afterRestartConnect = await page.locator('[data-testid="wb-switch-connect"]').getAttribute("aria-pressed");
  report.afterRestartAwake = await page.locator('[data-testid="wb-switch-awake"]').getAttribute("aria-pressed");
  report.afterRestartStatus = await page.evaluate(() => window.shell.remote.status());
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();
}
