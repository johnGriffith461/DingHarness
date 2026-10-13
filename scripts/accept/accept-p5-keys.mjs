import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 阶段 5.5 快捷键系统验收：四个新动作在真实应用里生效。
 *   Ctrl+D 复制选中节点（节点数 +1，副本错开 28px）
 *   Ctrl+M 开关标记模式（data-marker-tool 跟着变）
 *   Ctrl+Shift+M 清空标记
 *   Ctrl+0 适应视图
 *   快捷键说明面板列出全部条目
 */

const DATA = "D:/DoubaoWorkClone/data";
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9320"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9320");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const nodeCount = () => page.locator(".react-flow__node").count();
const tool = () => page.locator(".canvas-root").getAttribute("data-marker-tool");

const report = {};

// 选中第一个节点
/*
 * `.canvas-mode` 按钮在**弹出层**里（BottomToolbar 第 80 行的 `bottom-menu-pop`，
 * testid `bottom-modes`）—— 要先点 `bottom-select` 把它展开，模式按钮才出现。
 *（§112：之前直接点模式按钮必然超时，因为那时它还不存在。）
 */
await page.locator('[data-testid="bottom-select"]').click();
await page.waitForTimeout(700);
await page.waitForSelector('[data-testid="bottom-modes"]', { timeout: 8000 });
await page.locator('.canvas-mode[data-mode="point"]').click();
await page.waitForTimeout(200);
const box = await page.locator(".react-flow__node").first().boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + 8);
await page.waitForTimeout(300);
report.selectedBefore = await page.locator(".react-flow__node.selected").count();

// Ctrl+D 复制
const before = await nodeCount();
await page.keyboard.press("Control+d");
await page.waitForTimeout(600);
report.duplicate = { before, after: await nodeCount(), selected: await page.locator(".react-flow__node.selected").count() };

// Ctrl+M 开标记模式
report.toolBefore = await tool();
await page.keyboard.press("Control+m");
await page.waitForTimeout(400);
report.toolAfter = await tool();

// 在标记模式下画一条
const flow = await page.locator(".canvas-flow").boundingBox();
await page.mouse.move(flow.x + 60, flow.y + 60);
await page.mouse.down();
await page.mouse.move(flow.x + 180, flow.y + 140, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
report.marketCountAfterDraw = await page.locator('[data-testid="marker-count"]').textContent();

// Ctrl+Shift+M 清空标记
await page.keyboard.press("Control+Shift+m");
await page.waitForTimeout(400);
report.markerCountAfterClear = await page.locator('[data-testid="marker-count"]').textContent();

// 快捷键说明面板
await page.locator('[data-testid="shortcut-help"]').click();
await page.waitForTimeout(300);
report.cheatsheetRows = await page.locator('[data-testid="shortcut-cheatsheet"] .shortcut-row').count();
report.cheatsheetKeys = await page.locator('[data-testid="shortcut-cheatsheet"] kbd').allTextContents();
await page.screenshot({ path: "D:/DoubaoWorkClone/.verify/shots-p5/04-shortcuts.png" });

// Esc 退出标记模式
await page.locator('[data-testid="shortcut-help"]').click();
await page.keyboard.press("Control+m");
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
report.toolAfterEscape = await tool();

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();
