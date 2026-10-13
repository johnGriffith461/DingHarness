import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * 验收：账号菜单 + 「外观设置」子菜单（三选一）。
 *
 * 对齐本体的结构：账号头像 → 下拉菜单 → 「外观设置」→ 子菜单
 * （跟随系统 ✓ / 浅色模式 / 深色模式）。
 *
 * 测的是**行为**：点了菜单出不出来、勾在哪一项、选完颜色真变没变、
 * 刷新后记不记得住 —— 不是"那几行渲染出来没有"。
 */
const DATA = "D:/DoubaoWorkClone/.verify/acct-data";
fs.rmSync(DATA, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_DEBUG_PORT = "9921";
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn("D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=9921"], {
  cwd: "D:/DoubaoWorkClone",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

const out = {};
await new Promise((r) => setTimeout(r, 13000));
let browser;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9921");
  const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2200);

  const state = () =>
    page.evaluate(() => {
      const wb = document.querySelector(".wb");
      return {
        isDark: document.documentElement.getAttribute("data-theme") === "dark" ?? null,
        bg: wb ? getComputedStyle(wb).backgroundColor : null,
        stored: localStorage.getItem("dsh-canvas.theme"),
        menu: document.querySelectorAll('[data-testid="wb-account-menu"]').length,
        sub: document.querySelectorAll('[data-testid="wb-acct-theme-sub"]').length,
      };
    });

  out.initial = await state();

  // 1) 账号按钮开出菜单
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(800);
  out.afterOpen = await state();

  // 2) 菜单里有哪些项（对齐本体的 9 项）
  out.items = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="wb-acct-"]')]
      .map((e) => e.getAttribute("data-testid"))
      .filter((t) => t !== "wb-acct-menu" && t !== "wb-acct-theme-sub"),
  );

  // 3) 外观设置 → 子菜单三选一
  await page.locator('[data-testid="wb-acct-appearance"]').click();
  await page.waitForTimeout(700);
  out.afterSubmenu = await state();
  out.subOptions = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="wb-acct-theme-"]')]
      .filter((e) => e.getAttribute("data-testid") !== "wb-acct-theme-sub")
      .map((e) => ({ id: e.getAttribute("data-testid"), label: e.textContent?.trim() ?? "" })),
  );
  // 勾在哪一项（本体默认「跟随系统」）
  out.checkedDefault = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-acct-theme-system"] svg:last-child');
    return Boolean(el);
  });
  await page.screenshot({ path: ".verify/acct-menu.png" });

  // 4) 选深色模式 → 颜色真变
  await page.locator('[data-testid="wb-acct-theme-dark"]').click();
  await page.waitForTimeout(900);
  out.afterPickDark = await state();

  // 5) 刷新 → 记住
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2500);
  out.afterReload = await state();

  // 6) 选回浅色 → 变回去
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-appearance"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-theme-light"]').click();
  await page.waitForTimeout(900);
  out.afterPickLight = await state();

  await browser.close();
} catch (e) {
  out.error = String(e).slice(0, 240);
} finally {
  console.log(JSON.stringify(out, null, 2));
  child.kill();
}
