import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { shot } from "./harness.mjs";

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

  /* ── 「技能」命令面板：宽度与排版（2026-10-13 补） ──
   *
   * ⚠️ 这个面板**在此之前没有任何验收点过它**（`wb-skill-panel` 在 scripts/accept/ 里零命中），
   * 于是它烂了很久没人知道：面板宽高跟着**定位祖先**（`.wb-env`，只有 59px = 技能 chip 的宽），
   * 中文**一字一行**竖着排、还压在推荐卡上 —— 用户截图报上来的就是这个。
   * 断言量的是**排版结果**（宽 ≥ 240、首项高度 ≤ 60 即"一行放得下"），不是"元素在不在"。
   */
  await page.locator('[data-testid="wb-skills"]').click();
  await page.waitForTimeout(700);
  out.skillPanel = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-skill-panel"]');
    if (!el) return null;
    const first = el.querySelector('[data-testid^="wb-cmd-"]');
    return {
      width: Math.round(el.getBoundingClientRect().width),
      firstItemHeight: first ? Math.round(first.getBoundingClientRect().height) : null,
      hasSearch: Boolean(el.querySelector('[data-testid="wb-cmd-search"]')),
      items: el.querySelectorAll('[data-testid^="wb-cmd-"]').length,
    };
  });
  await shot(page, "chips-skillpanel.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

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
  /* 技能面板：排版断言（不是"元素在不在"） */
  if (!out.skillPanel) bad.push("「技能」命令面板打不开（wb-skill-panel）");
  else {
    if (out.skillPanel.width < 240) bad.push(`⭐ 技能面板被挤成 ${out.skillPanel.width}px（中文会一字一行）`);
    if ((out.skillPanel.firstItemHeight ?? 0) > 60) {
      bad.push(`⭐ 技能面板首项高 ${out.skillPanel.firstItemHeight}px —— 说明文字竖排了（一行应当 ≤ 40px 上下）`);
    }
    if (!out.skillPanel.hasSearch) bad.push("技能面板底部没有搜索框");
    if (out.skillPanel.items < 3) bad.push(`技能面板条目太少（${out.skillPanel.items} 条）`);
  }
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 三个问题都好了");
  }
}
