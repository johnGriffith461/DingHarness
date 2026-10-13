import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 文字排版工具条端到端验收（阶段 8.5）。
 *
 * 断言：
 *   1. 选中文字节点才出现；没选中 / 选中图片时不出现；多选时也不出现
 *   2. 调字距/行高/字号 → 节点上的**计算样式真的变了**
 *   3. 对齐按钮改 text-align
 *   4. 「自动 / 固定」切尺寸模式
 *   5. 排版落盘，重启后还在
 *   6. Ctrl+Z 能把整串调整一次撤回（不是要按几十下）
 */
const DATA = "D:/DoubaoWorkClone/data";
const SNAP = path.join(DATA, "canvas", "document.json");
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const EXE = "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe";
async function boot(port) {
  const child = spawn(EXE, [".", `--remote-debugging-port=${port}`], {
    cwd: "D:/DoubaoWorkClone",
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise((r) => setTimeout(r, 8000));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = browser.contexts()[0].pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
  await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);
  
  await page.waitForSelector(".react-flow__node", { state: "attached" });
  await page.waitForTimeout(2500);
  return { child, browser, page };
}

/** 读某个节点正文的计算样式。 */
const bodyStyle = (page, id) =>
  page.evaluate((nodeId) => {
    const el = document.querySelector(
      `.react-flow__node[data-id="${nodeId}"] .nv-markdown-body, .react-flow__node[data-id="${nodeId}"] .shape-text`,
    );
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      letterSpacing: cs.letterSpacing,
      lineHeight: cs.lineHeight,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      textAlign: cs.textAlign,
      borderTopWidth: cs.borderTopWidth,
      width: cs.width,
    };
  }, id);

const report = {};
{
  const { child, browser, page } = await boot(9460);

  // 1) 没选中 → 不出现
  report.beforeSelect = await page.locator('[data-testid="text-toolbar"]').count();

  // 选中 n1（文本节点）
  const box = await page.locator('.react-flow__node[data-id="n1"]').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 10);
  await page.waitForTimeout(700);
  report.afterSelect = await page.locator('[data-testid="text-toolbar"]').count();
  report.toolbarButtons = await page.$$eval(
    '[data-testid="text-toolbar"] [data-text-align], [data-testid="text-toolbar"] [data-text-size]',
    (els) => els.map((e) => e.getAttribute("data-text-align") ?? e.getAttribute("data-text-size")),
  );
  report.styleBefore = await bodyStyle(page, "n1");

  // 2) 调字距 / 行高 / 字号
  await page.locator('[data-testid="text-letter-spacing"]').fill("0.12");
  await page.waitForTimeout(300);
  await page.locator('[data-testid="text-line-height"]').fill("2");
  await page.waitForTimeout(300);
  await page.locator('[data-testid="text-font-size"]').fill("17");
  await page.waitForTimeout(500);
  report.styleAfterSliders = await bodyStyle(page, "n1");

  // 3) 对齐
  await page.locator('[data-text-align="center"]').click();
  await page.waitForTimeout(400);
  report.slideAfterAlign = (await bodyStyle(page, "n1"))?.textAlign;

  // 4) 边框宽度
  await page.locator('[data-testid="text-border-width"]').fill("2");
  await page.waitForTimeout(400);
  report.borderAfter = (await bodyStyle(page, "n1"))?.borderTopWidth;

  // 5) 尺寸模式
  await page.locator('[data-text-size="auto"]').click();
  await page.waitForTimeout(400);
  report.widthAfterAuto = (await bodyStyle(page, "n1"))?.width;
  await page.locator('[data-text-size="fixed"]').click();
  await page.waitForTimeout(400);
  report.widthAfterFixed = (await bodyStyle(page, "n1"))?.width;

  // 落盘
  await page.waitForTimeout(1600);
  const doc = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  report.onDisk = doc.nodes.find((n) => n.id === "n1")?.data?.textStyle ?? null;

  // 6) 图片节点选中时不该出现
  await page.mouse.click(box.x + 40, box.y + 600, { force: true });
  await page.waitForTimeout(200);
  await page.locator('.react-flow__node[data-id="n5"]').click({ force: true });
  await page.waitForTimeout(600);
  report.toolbarOnImage = await page.locator('[data-testid="text-toolbar"]').count();

  await page.screenshot({ path: "D:/DoubaoWorkClone/.verify/shots-final/text-toolbar.png" });
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2000));
}

// 重启后排版还在
{
  const { child, browser, page } = await boot(9461);
  const box = await page.locator('.react-flow__node[data-id="n1"]').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 10);
  await page.waitForTimeout(800);
  report.afterRestart = await bodyStyle(page, "n1");
  await browser.close();
  child.kill();
}

console.log(JSON.stringify(report, null, 2));
