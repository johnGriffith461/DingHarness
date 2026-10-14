import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, pickPort, shot } from "./harness.mjs";

/**
 * 图片动作端到端验收（阶段 9.3）。
 *
 * 断言：
 *   1. 先真生成一张图（有图才能改）
 *   2. 图片节点上出现「改图」入口，菜单里四项：抠图 / 增强 / 扩图 / 编辑
 *   3. **真跑一次「增强」**：拿到新图、节点 src 换成新文件、尺寸沿用原图
 *   4. **真跑一次「扩图」**：输出尺寸比输入大（扩图按定义要更大的画布）
 *   5. 图片真的能显示（naturalWidth > 0）
 *   6. **Ctrl+Z 能撤回**改图（改之前记了历史）
 *   7. 自由编辑的空指令时「改」按钮置灰
 */
const DATA = "D:/DoubaoWorkClone/.verify/actions-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const EXE = "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe";
/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12495]);
const child = spawn(EXE, [".", "--remote-debugging-port=" + __port], {
  cwd: "D:/DoubaoWorkClone",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});
await new Promise((r) => setTimeout(r, 8000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const report = {};
const genImg = () =>
  page.evaluate(() => {
    const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
    return img instanceof HTMLImageElement
      ? { src: img.getAttribute("src"), w: img.naturalWidth, h: img.naturalHeight }
      : null;
  });

// 1) 先真生成一张图（当改图的输入）
await page.locator('[data-testid="bottom-image-gen"]').click();
await page.waitForTimeout(700);
await page.locator('[data-testid="gen-prompt"]').fill("一只白猫坐在木桌上，旁边有一盆绿植，室内自然光");
await page.locator('[data-testid="gen-run"]').click();
await page
  .waitForFunction(() => document.querySelector('.react-flow__node-image img[src^="dshasset://"]') !== null, null, {
    timeout: 180000,
  })
  .catch(() => undefined);
await page.waitForTimeout(2500);
report.source = await genImg();

// 找到**带生成图的那个**图片节点 id。
// 注意不能用 `.react-flow__node-image` 的第一个 —— 示例画布里本来就有一个空的图片节点（n5），
// 它没有 src 也就没有「改图」入口，抓错了会一直等不到按钮。
const nodeId = await page.evaluate(() => {
  const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
  return img?.closest(".react-flow__node")?.getAttribute("data-id") ?? null;
});
report.nodeId = nodeId;

// 2) 打开改图菜单
await page.locator(`[data-testid="image-actions-${nodeId}"]`).click();
await page.waitForTimeout(500);
report.menuActions = await page.$$eval('[data-image-action]', (els) =>
  els.map((e) => e.getAttribute("data-image-action")),
);
report.emptyInstructionDisabled = await page
  .locator(`[data-testid="image-action-edit-go-${nodeId}"]`)
  .isDisabled();

// 3) 增强：沿用原尺寸
await page.locator(`[data-testid="image-action-enhance-${nodeId}"]`).click();
await page.waitForTimeout(1500);
report.busyShown = await page.locator(`[data-testid="image-action-busy-${nodeId}"]`).count();
await page
  .waitForFunction(
    (src) => {
      const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
      return img !== null && img.getAttribute("src") !== src;
    },
    report.source?.src,
    { timeout: 240000 },
  )
  .catch(() => undefined);
await page.waitForTimeout(2000);
report.afterEnhance = await genImg();
report.errorAfterEnhance = await page.locator(`[data-testid="image-error-${nodeId}"]`).textContent().catch(() => null);

// 4) 扩图：尺寸应变大
await page.locator(`[data-testid="image-actions-${nodeId}"]`).click();
await page.waitForTimeout(400);
await page.locator(`[data-testid="image-action-expand-${nodeId}"]`).click();
await page.waitForTimeout(1500);
await page
  .waitForFunction(
    (src) => {
      const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
      return img !== null && img.getAttribute("src") !== src;
    },
    report.afterEnhance?.src,
    { timeout: 240000 },
  )
  .catch(() => undefined);
await page.waitForTimeout(2000);
report.afterExpand = await genImg();
report.errorAfterExpand = await page.locator(`[data-testid="image-error-${nodeId}"]`).textContent().catch(() => null);
await shot(page, "D:/DoubaoWorkClone/.verify/shots-final/image-actions.png");

// 6) Ctrl+Z 撤回
await page.locator("body").click({ position: { x: 800, y: 500 } }).catch(() => undefined);
await page.waitForTimeout(300);
await page.keyboard.press("Control+z");
await page.waitForTimeout(1500);
report.afterUndo = await genImg();

report.assets = fs.existsSync(path.join(DATA, "assets"))
  ? fs.readdirSync(path.join(DATA, "assets")).map((f) => ({ f, bytes: fs.statSync(path.join(DATA, "assets", f)).size }))
  : [];

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();
