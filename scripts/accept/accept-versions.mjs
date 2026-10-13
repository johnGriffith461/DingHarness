import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 版本历史面板端到端验收（对标原版 `canvas_versions_*`）。
 *
 * 断言：
 *   1. 面板能列出磁盘上的历史版本，并标出"最新版本 = 当前"
 *   2. 预览某个历史版本 → 显示该版的节点/连线/标记数
 *   3. 点「恢复此版本」→ 画布内容真的回到那一版，且**修订号继续变大**（不回退）
 *   4. 恢复本身也会成为新的历史条目
 */

const DATA = "D:/DoubaoWorkClone/data";
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9360"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9360");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const report = {};
const nodeCount = () => page.locator(".react-flow__node").count();

// 造三个版本：初始(6) → +1(7) → +2(8)
report.v0 = await nodeCount();
for (const kind of ["whiteboard", "mermaid"]) {
  await page.locator('[data-testid="add-node"]').click();
  await page.waitForTimeout(220);
  await page.locator(`.canvas-menu button[data-kind="${kind}"]`).click();
  await page.waitForTimeout(2000); // 等自动保存
}
report.currentNodes = await nodeCount();

// 打开版本历史
await page.locator('[data-testid="open-versions"]').click();
await page.waitForTimeout(600);
report.panelOpen = await page.locator('[data-testid="versions-panel"]').count();
report.latestLabel = await page.locator(".versions-item.is-latest .versions-item-name").textContent();
report.revisions = await page
  .locator('[data-testid="versions-list"] .versions-item:not(.is-latest) .versions-item-name')
  .allTextContents();

// 预览最老的一版（列表最后一个）
const buttons = page.locator('[data-testid^="version-preview-"]');
const n = await buttons.count();
report.previewButtons = n;
const oldestRev = (await buttons.last().getAttribute("data-testid"))?.replace("version-preview-", "");
await buttons.last().click();
await page.waitForTimeout(600);
report.previewText = (await page.locator('[data-testid="versions-preview"]').textContent()) ?? null;
report.oldestRev = oldestRev;

// 恢复到那一版
await page.locator(`[data-testid="version-restore-${oldestRev}"]`).click();
await page.waitForTimeout(2500);
report.afterRestoreNodes = await nodeCount();
report.noteAfterRestore = await page.locator(".versions-note").textContent().catch(() => null);
report.statusAfter = await page.locator(".canvas-statusbar").textContent();

// 恢复后历史里应该多出一条更大的修订号
await page.locator('[data-testid="open-versions"]').click();
await page.waitForTimeout(300);
await page.locator('[data-testid="open-versions"]').click();
await page.waitForTimeout(800);
report.revisionsAfterRestore = await page
  .locator('[data-testid="versions-list"] .versions-item:not(.is-latest) .versions-item-name')
  .allTextContents();

const doc = JSON.parse(fs.readFileSync(path.join(DATA, "canvas", "document.json"), "utf8"));
report.disk = { revision: doc.revision, nodes: doc.nodes.length, confirmed: doc.confirmedRevision };

await page.screenshot({ path: "D:/DoubaoWorkClone/.verify/shots-p5/06-versions.png" });
console.log(JSON.stringify(report, null, 2));

await browser.close();
child.kill();
