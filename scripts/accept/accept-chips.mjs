import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * 验收：输入区三个 chip（用户报的三个问题）。
 *
 *   ① 「本地电脑」**已删掉**（默认就是它，没有可选项时留着没用）
 *   ② 「项目」点了**要有下拉**（原来是没有 onClick 的死按钮）
 *   ③ 「按需确认」点了**要有下拉**
 *
 * 验的是**点了之后 DOM 里真出现了选项** —— 不是"按钮渲染出来没有"。
 * 死按钮恰恰是"渲染出来了、点了没反应"，所以只查存在性是查不出来的。
 */
const DATA = "D:/DoubaoWorkClone/.verify/chip-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_DEBUG_PORT = "9971";
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn("D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=9971"], {
  cwd: "D:/DoubaoWorkClone",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

const out = {};
await new Promise((r) => setTimeout(r, 13000));
try {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9971");
  const page = b.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2200);

  // ① 环境 chip 应该没了
  out.envChipGone = (await page.locator('[data-testid="wb-env"]').count()) === 0;
  out.envTextStillThere = await page.evaluate(() =>
    [...document.querySelectorAll(".wb-composer-bar .wb-chip")].some((e) => (e.textContent ?? "").includes("本地电脑")),
  );
  out.chips = await page.evaluate(() =>
    [...document.querySelectorAll(".wb-composer-bar .wb-chip")].map((e) => (e.textContent ?? "").trim()),
  );

  // ② 项目 → 下拉
  await page.locator('[data-testid="wb-project"]').click();
  await page.waitForTimeout(600);
  out.projectPopOpened = (await page.locator('[data-testid="wb-project-pop"]').count()) === 1;
  out.projectPopText = await page.evaluate(
    () => document.querySelector('[data-testid="wb-project-pop"]')?.textContent?.trim() ?? null,
  );

  // ③ 按需确认 → 下拉（先关掉项目那个）
  await page.locator('[data-testid="wb-project"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-confirm"]').click();
  await page.waitForTimeout(600);
  out.confirmPopOpened = (await page.locator('[data-testid="wb-confirm-pop"]').count()) === 1;
  out.confirmOptions = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="wb-confirm-option-"]')].map((e) => e.textContent?.trim() ?? ""),
  );
  await page.screenshot({ path: ".verify/chips.png" });

  // 真选一个，看 chip 上的字有没有跟着变（"能选"的证据）
  await page.locator('[data-testid="wb-confirm-option-每步确认"]').click();
  await page.waitForTimeout(500);
  out.confirmAfterPick = await page.evaluate(
    () => document.querySelector('[data-testid="wb-confirm"]')?.textContent?.trim() ?? null,
  );


  /*
   * 刷新后还记不记得（§143）。
   *
   * 原来那个 chip 是 `useState("全部允许")` —— **局部 state**：
   * 用户选了「每步确认」，离开再回来就变回「全部允许」。
   * 而审批闸门要靠这个选择做判定（它随请求过给主进程），所以"记不住"不只是体验问题。
   */
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2000);
  out.confirmAfterReload = await page.evaluate(
    () => document.querySelector('[data-testid="wb-confirm"]')?.textContent?.trim() ?? null,
  );

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 220);
} finally {
  console.log(JSON.stringify(out, null, 2));
  child.kill();
  const bad = [];
  if (!out.envChipGone) bad.push("「本地电脑」chip 还在");
  if (!out.projectPopOpened) bad.push("「项目」没有下拉");
  if (!out.confirmPopOpened) bad.push("「按需确认」没有下拉");
  if (!(out.confirmAfterPick ?? "").includes("每步确认")) bad.push("选了没生效: " + out.confirmAfterPick);
  if (!(out.confirmAfterReload ?? "").includes("每步确认")) bad.push("档位刷新后没记住：" + out.confirmAfterReload);
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 三个问题都好了");
  }
}
