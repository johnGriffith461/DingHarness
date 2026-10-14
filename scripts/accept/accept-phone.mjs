import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, pickPort, readStoreFile, shot, verdict, waitForPage } from "./harness.mjs";

/**
 * 11.26 验收：手机遥控电脑页的两个开关是**真状态**。
 *
 * 关键断言是**跨重启**：
 *   · 「可被同账号设备连接与控制」是**许可** → 关掉后重启仍是关的（写盘）；
 *   · 「让这台设备保持唤醒状态」是这台机器的**真实状态** → 由主进程
 *     `powerSaveBlocker` 持有，重启后应回到"关"（没有人在阻止休眠了）。
 *
 * 原来两个都是渲染进程里的 useState —— 重启回到默认值，用户会以为"设了没用"。
 *
 * ── 2026-10-13 两处修正 ──
 *
 * ① **起应用改用 `bootApp`（等真端口）**，不再"固定等 8 秒然后连"。
 *    原来固定 9660/9661：这台机器上 **9660 绑不上**（`bind()` 报 WSAEACCES，
 *    端口没开 → `ECONNREFUSED` → 脚本崩，而真因是端口不是产品）。
 *    现在换用 9680/9681，并且"端口真开了才往下走"；起不来就直说端口没开。
 * ② **加了判定**（`verdict`）。原来它只 `console.log` 一个报告就退，**从不判定** ——
 *    于是"开关没写盘"这种真问题它永远是绿的（§109 那条"只点按钮不验证后果"的形态）。
 */
const DATA = "D:/DoubaoWorkClone/.verify/phone-data";
/* 先杀掉上一轮残留再删目录：Windows 上被句柄占着的目录会报 EPERM（§135 撞过）。 */
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

async function launch(port) {
  /* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
  port = await pickPort([port]);
  const { child, ok, getLog } = await bootApp({ port, dataDir: DATA });
  if (!ok) {
    console.error(`✗ 应用起了但调试端口 ${port} 没开 —— 看下面这段日志：\n${getLog()}`.slice(0, 1200));
    process.exit(1);
  }
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${port}`);
  const page = await waitForPage(browser);
  if (!page) {
    console.error("✗ " + NO_PAGE_HINT);
    process.exit(1);
  }
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { child, browser, page };
}

const report = {};
const shots = "D:/DoubaoWorkClone/.verify/shots-final";
let { child, browser, page } = await launch(12680);

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

  /*
   * ⚠️ 2026-10-13 补：`wb-page-phone`（页面骨架）与 `wb-phone-mock`（右边那台"样机"）
   * **原来没有任何脚本引用过**（`src/` × `scripts/accept/` 交叉，见 HANDOFF §208 的零覆盖清单）。
   * 上面数的是 `.wb-mock-menu-row`（class），**容器本身**没人看过 ——
   * 容器没渲染、内容悬空、被挤塌（§201 那类 59px）都不会红。
   * 断**后果**：页面骨架在、样机在且**里面有行**、宽度正常。
   */
  report.pageBox = await page.locator('[data-testid="wb-page-phone"]').count();
  report.mockBox = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="wb-phone-mock"]');
    return {
      count: box ? 1 : 0,
      rows: box ? box.querySelectorAll(".wb-mock-menu-row").length : 0,
      width: box ? Math.round(box.getBoundingClientRect().width) : null,
    };
  });
  await shot(page, path.join(shots, "wb-24-phone.png"));

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
  report.remoteJson = fs.existsSync(remoteFile) ? readStoreFile(remoteFile) : null;

  /* ---------- 重启：许可保持关、唤醒回到关 ---------- */
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2500));

  ({ child, browser, page } = await launch(12681));
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

/*
 * 判定（2026-10-13 补）。
 *
 * 这几条正是这个页面的**存在理由**：两个开关都得是"真状态"而不是渲染进程里的 useState。
 * 特别注意第 ② 条 —— 它同时钉住了 C1 的落盘信封：`remote.json` 现在长这样
 * `{ "__schema": 1, "data": { "allowConnect": … } }`，脱掉信封之后 `allowConnect` 必须是**真的 false**
 * （而不是"文件里有这个字就算过"）。
 */
const bad = [];
if (report.defaultConnect !== "true") bad.push(`默认许可应为开，实际 ${report.defaultConnect}`);
if (report.defaultAwake !== "false") bad.push(`默认唤醒应为关，实际 ${report.defaultAwake}`);
/* ② 许可真的写进磁盘了（脱信封之后看 allowConnect） */
if (report.remoteJson?.allowConnect !== false) {
  bad.push(`关掉的许可没落盘：remote.json 里 allowConnect = ${JSON.stringify(report.remoteJson)}`);
}
/* ③ 跨重启：许可是许可（保持关），唤醒是机器真实状态（回到关） */
if (report.afterRestartConnect !== "false") bad.push(`重启后许可应仍是关，实际 ${report.afterRestartConnect}`);
if (report.afterRestartAwake !== "false") bad.push(`重启后唤醒应回到关，实际 ${report.afterRestartAwake}`);
/* ④ 补的那组（零覆盖清单里的页面骨架与"样机"容器，§208） */
if (report.pageBox !== 1) bad.push("手机遥控页没有页面骨架（wb-page-phone）");
if (report.mockBox?.count !== 1) bad.push("右侧那台「样机」没有容器（wb-phone-mock）");
else {
  if ((report.mockBox.rows ?? 0) < 1) bad.push("「样机」里一行内容都没有");
  if (!(report.mockBox.width > 100)) bad.push(`⭐ 「样机」被挤塌了（宽 ${report.mockBox.width}px）`);
}
verdict(bad, "手机遥控成立：默认态对齐实机 / 许可真的写盘 / 重启后许可是关、唤醒回到关 / 骨架与样机在");
