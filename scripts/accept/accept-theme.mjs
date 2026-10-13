import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * 验收：设置里的「外观」是真开关 —— 点了会变、刷新后记住、能切回来。
 *
 * 这正是这个项目反复在清的那类缺陷（"看着有、其实没用"），
 * 所以**必须点一遍看计算样式真变了**，而不是只看那一行有没有渲染出来。
 */
const DATA = "D:/DoubaoWorkClone/.verify/theme-data";
fs.rmSync(DATA, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_DEBUG_PORT = "9888";
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9888"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);

const report = {};
const read = (page) =>
  page.evaluate(() => {
    const wb = document.querySelector(".wb");
    return {
      isDark: document.documentElement.getAttribute("data-theme") === "dark" ?? null,
      bg: wb ? getComputedStyle(wb).backgroundColor : null,
      stored: localStorage.getItem("dsh-canvas.theme"),
    };
  });

await new Promise((r) => setTimeout(r, 13000));
let browser;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9888");
  const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2200);

  report.initial = await read(page);

  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(900);
  report.rowValue = await page.locator('[data-testid="wb-set-theme-value"]').textContent();

  await page.locator('[data-testid="wb-set-外观"]').click();
  await page.waitForTimeout(1000);
  report.afterToggle = await read(page);
  report.rowValueAfter = await page.locator('[data-testid="wb-set-theme-value"]').textContent();

  await page.screenshot({ path: ".verify/theme-toggled.png" });

  // 切回来，确认是双向的
  await page.locator('[data-testid="wb-set-外观"]').click();
  await page.waitForTimeout(900);
  report.afterToggleBack = await read(page);

  // 再切成深色，然后刷新，确认"记住"
  await page.locator('[data-testid="wb-set-外观"]').click();
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2500);
  report.afterReload = await read(page);

  await browser.close();
} catch (error) {
  report.error = String(error).slice(0, 200);
} finally {
  console.log(JSON.stringify(report, null, 2));
  child.kill();
}
