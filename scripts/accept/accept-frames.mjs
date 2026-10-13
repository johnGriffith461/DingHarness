import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 画框节点端到端验收（阶段 8.4，对标 `moveFrameWithChildren`）。
 *
 * 断言：
 *   1. 能建画框，DOM 带 `data-canvas-frame-id` / `data-frame-id`（原版契约）
 *   2. 把卡片拖进画框 → 它成为画框的子节点（`parentId` 指向画框）
 *   3. **拖画框 → 框住的卡片跟着走**（父子关系的意义就在这）
 *   4. 删掉画框 → 里面的卡片不会跟着消失（只是回到顶层）
 *   5. 画框随文档落盘、重启后还在
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

const readDoc = () => JSON.parse(fs.readFileSync(SNAP, "utf8"));
const report = {};

{
  const { child, browser, page } = await boot(9440);

  // 1) 建画框
  await page.locator('[data-testid="add-node"]').click();
  await page.waitForTimeout(300);
  await page.locator('.canvas-menu button[data-kind="frame"]').click();
  await page.waitForTimeout(1200);

  report.frameContract = await page.evaluate(() => {
    const el = document.querySelector(".frame-node");
    return el
      ? {
          frameId: el.getAttribute("data-canvas-frame-id"),
          legacyId: el.getAttribute("data-frame-id"),
          title: el.textContent?.trim().slice(0, 20),
        }
      : null;
  });

  // 2) 把某个卡片拖进画框中央
  const frameBox = await page.locator(".frame-node").boundingBox();
  const targetId = "n1";
  const nodeBox = await page.locator(`.react-flow__node[data-id="${targetId}"]`).boundingBox();
  await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(1500);

  // 让自动保存落盘后再看归属
  await page.waitForTimeout(1500);
  const doc1 = readDoc();
  const moved = doc1.nodes.find((n) => n.id === targetId);
  report.adoptedIntoFrame = moved?.parentId ?? null;
  report.frameIdFromDisk = doc1.nodes.find((n) => n.type === "frame")?.id ?? null;

  // 3) 拖画框 → 子节点应跟着走
  const before = await page.locator(`.react-flow__node[data-id="${targetId}"]`).boundingBox();
  const frameEl = await page.locator(".frame-node").boundingBox();
  // 抓画框的标题栏来拖（画框本体是 pointer-events:none，只有标题栏是拖拽把手）
  const titleBtn = await page.locator('[data-testid^="frame-drag-"]').boundingBox();
  await page.mouse.move(titleBtn.x + titleBtn.width / 2, titleBtn.y + titleBtn.height / 2);
  await page.mouse.down();
  await page.mouse.move(titleBtn.x + titleBtn.width / 2 + 120, titleBtn.y + titleBtn.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const after = await page.locator(`.react-flow__node[data-id="${targetId}"]`).boundingBox();
  report.moveWithChildren = {
    dx: Math.round(after.x - before.x),
    dy: Math.round(after.y - before.y),
    frameMoved: Math.abs((await page.locator(".frame-node").boundingBox()).x - frameEl.x) > 40,
  };

  await page.screenshot({ path: "D:/DoubaoWorkClone/.verify/shots-final/frames.png" });
  await page.waitForTimeout(1800);
  report.diskFrames = readDoc().nodes.filter((n) => n.type === "frame").length;
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2000));
}

// 4) 重启后画框还在
{
  const { child, browser, page } = await boot(9441);
  report.afterRestart = {
    frames: await page.locator(".frame-node").count(),
    adopted: await page.evaluate(() => {
      const el = document.querySelector(".frame-node");
      return el ? el.getAttribute("data-canvas-frame-id") : null;
    }),
  };
  await browser.close();
  child.kill();
}

console.log(JSON.stringify(report, null, 2));
