import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { freshDir, killTree, shot } from "./harness.mjs";

/**
 * 验收：记忆（对应本体 `chat/memory/list|clear|delete`）。
 *
 * 走真实路径：账号菜单 → 设置 → 点「记忆」→ 加一条 → **刷新** → 还在 → 删掉。
 * 重点是**刷新后还在** —— "加完能用、重启就没了"是这个项目犯过的错（§49）。
 */
const DATA = "D:/DoubaoWorkClone/.verify/mem-data";
// 先杀残留再删：Windows 上被句柄占着的目录会报 EPERM（§135 撞过）。
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_DEBUG_PORT = "9994";
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn("D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=9994"], {
  cwd: "D:/DoubaoWorkClone",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

const out = {};
const openSettings = async (page) => {
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);
};

await new Promise((r) => setTimeout(r, 13000));
let browser;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9994");
  const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2200);

  await openSettings(page);

  // 那一行应该已经**不再禁用**，且显示"暂无"
  out.rowDisabled = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-set-记忆"]');
    return el ? el.hasAttribute("disabled") : null;
  });
  out.rowValue = await page.evaluate(
    () => document.querySelector('[data-testid="wb-set-记忆"]')?.textContent?.trim() ?? null,
  );

  await page.locator('[data-testid="wb-set-记忆"]').click();
  await page.waitForTimeout(700);
  out.panelOpen = (await page.locator('[data-testid="wb-memory"]').count()) === 1;

  await page.locator('[data-testid="wb-memory-input"]').fill("回答尽量简短，别用客套话");
  await page.locator('[data-testid="wb-memory-add"]').click();
  await page.waitForTimeout(900);
  out.afterAdd = await page.evaluate(() => ({
    items: document.querySelectorAll(".wb-memory-item").length,
    text: document.querySelector(".wb-memory-text")?.textContent ?? null,
  }));

  // 刷新 —— 关键一步
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await openSettings(page);
  out.afterReloadRowValue = await page.evaluate(
    () => document.querySelector('[data-testid="wb-set-记忆"]')?.textContent?.trim() ?? null,
  );
  await page.locator('[data-testid="wb-set-记忆"]').click();
  await page.waitForTimeout(800);
  out.afterReload = await page.evaluate(() => ({
    items: document.querySelectorAll(".wb-memory-item").length,
    text: document.querySelector(".wb-memory-text")?.textContent ?? null,
  }));

  // 删掉
  const dropId = await page.evaluate(() =>
    document.querySelector('[data-testid^="wb-memory-drop-"]')?.getAttribute("data-testid") ?? null,
  );
  if (dropId) {
    await page.locator(`[data-testid="${dropId}"]`).click();
    await page.waitForTimeout(800);
  }
  out.afterDrop = await page.evaluate(() => ({
    items: document.querySelectorAll(".wb-memory-item").length,
    empty: document.querySelectorAll('[data-testid="wb-memory-empty"]').length,
  }));

  // 截图是留给人看的证据，不是判定依据 —— 偶发超时不该把功能全过的验收拖红。
  out.shot = await shot(page, "memory.png");
  await browser.close();
} catch (e) {
  out.error = String(e).slice(0, 220);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);
  const bad = [];
  if (out.rowDisabled !== false) bad.push("「记忆」那一行还是禁用的");
  if (!out.panelOpen) bad.push("面板没打开");
  if ((out.afterAdd?.items ?? 0) !== 1) bad.push("加完没有 1 条");
  if ((out.afterReload?.items ?? 0) !== 1) bad.push("刷新后丢了（关键）");
  if ((out.afterDrop?.items ?? -1) !== 0) bad.push("删完还剩");
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 记忆可用且刷新后仍在");
  }
}
