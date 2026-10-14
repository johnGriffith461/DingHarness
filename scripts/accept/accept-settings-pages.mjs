import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { connectWithRetry, freshDir, killTree, shot } from "./harness.mjs";

/** 验：设置里「标准套餐」→ 个人资料页、「账号」→ 账号页，且能返回。 */
const DATA = "D:/DoubaoWorkClone/.verify/setp-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_DEBUG_PORT = "9995";
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn("D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=9995"], {
  cwd: "D:/DoubaoWorkClone",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

const out = {};
await new Promise((r) => setTimeout(r, 13000));
try {
  const b = await connectWithRetry(chromium, "http://127.0.0.1:9995");
  const page = b.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2200);

  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);

  out.rowsVisible = await page.evaluate(() => ({
    标准套餐: document.querySelectorAll('[data-testid="wb-set-标准套餐"]').length,
    账号: document.querySelectorAll('[data-testid="wb-set-账号"]').length,
    记忆: document.querySelectorAll('[data-testid="wb-set-记忆"]').length,
  }));

  // 点「标准套餐」→ profile
  await page.locator('[data-testid="wb-set-标准套餐"]').click();
  await page.waitForTimeout(700);
  out.profilePage = (await page.locator('[data-testid="wb-setpage-profile"]').count()) === 1;
  out.profileText = await page.evaluate(() => document.querySelector(".wb-setpage-body")?.textContent?.trim().slice(0, 40) ?? null);
  out.rowsHiddenOnSub = (await page.locator('[data-testid="wb-set-记忆"]').count()) === 0;

  // 返回
  await page.locator('[data-testid="wb-setpage-back"]').click();
  await page.waitForTimeout(600);
  out.backToRows = (await page.locator('[data-testid="wb-set-记忆"]').count()) === 1;

  // 账号页
  await page.locator('[data-testid="wb-set-账号"]').click();
  await page.waitForTimeout(700);
  out.accountPage = (await page.locator('[data-testid="wb-setpage-account"]').count()) === 1;

  out.shot = await shot(page, "setpage.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 200);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);
  const bad = [];
  if ((out.rowsVisible?.账号 ?? 0) !== 1) bad.push("没有「账号」行");
  if (!out.profilePage) bad.push("「标准套餐」没打开个人资料页");
  if (!out.rowsHiddenOnSub) bad.push("子页开了但主列表还在");
  if (!out.backToRows) bad.push("返回没回到主列表");
  if (!out.accountPage) bad.push("「账号」没打开账号页");
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 设置子页可用（资料 / 账号 / 返回）");
  }
}
