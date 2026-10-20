import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { connectWithRetry, freshDir, killTree, pickPort, shot, waitForPort, dismissFirstRunIfShown } from "./harness.mjs";

/** 验：设置里「本机档案」→ 个人资料页、「账号」→ 账号页，且能返回。 */
const DATA = ".verify/setp-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12995]);
/* 应用只认这个环境变量（命令行那个在打包产物里会被忽略）—— 两处必须是同一个端口。 */
env.DSH_DEBUG_PORT = String(__port);
const child = spawn("node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=" + __port], {
  cwd: ".",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

const out = {};
/* 固定等 13 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);
try {
  const b = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
  const page = b.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await dismissFirstRunIfShown(page);
  await page.waitForTimeout(2200);

  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(800);

  out.rowsVisible = await page.evaluate(() => ({
    本机档案: document.querySelectorAll('[data-testid="wb-set-本机档案"]').length,
    账号: document.querySelectorAll('[data-testid="wb-set-账号"]').length,
    记忆: document.querySelectorAll('[data-testid="wb-set-记忆"]').length,
    /*
     * §2.4 #8（2026-10-17）：用户裁定「订阅与额度管理」不需要 → 按"不留死控件"的
     * 纪律**移除**（原来是一行 disabled + "需要账号服务端"）。这里钉住"它不该再出现"。
     */
    订阅额度残留: document.querySelectorAll('[data-testid="wb-set-订阅与额度管理"]').length,
    /* D02（2026-10-18）：「标准套餐」是在承诺一个本机版没有的订阅商品，钉住它不该回来 */
    标准套餐残留: document.querySelectorAll('[data-testid="wb-set-标准套餐"]').length,
  }));

  // 点「本机档案」→ profile
  await page.locator('[data-testid="wb-set-本机档案"]').click();
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
  /* §2.4 #8：那一行已移除（不是留灰） */
  if ((out.rowsVisible?.订阅额度残留 ?? -1) !== 0) bad.push("「订阅与额度管理」那一行还在（清尾口径：移除）");
  if ((out.rowsVisible?.标准套餐残留 ?? -1) !== 0) bad.push("「标准套餐」又回来了（本机版没有订阅商品）");
  if (!out.profilePage) bad.push("「本机档案」没打开个人资料页");
  /*
   * ⚠️ 2026-10-16：原来这里断言「子页开了主列表就该消失」—— 那是**弹窗**时代的口径。
   * 设置改成 ZCode 那种**整页两列**之后，左轨本来就该一直在（那正是两列的意思），
   * 所以这条断言**退休**：现在只要求「子页真的打开了」（上面那条 profilePage 已经在盯）。
   */
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
