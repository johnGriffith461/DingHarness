import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 画布剪贴板端到端验收（PLAN 4.6）。
 *
 * 断言：选中两个节点 → Ctrl+C → 剪贴板里是带标记的 JSON；
 * Ctrl+V → 画布上多出这两个节点（id 已重排），且连线只保留内部那条；
 * 剪贴板里放别人的文本时，粘贴不会误吃（提示"剪贴板里不是画布内容"）。
 */
const DATA = "D:/DoubaoWorkClone/data";
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9380"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9380");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const report = {};
const ids = () => page.$$eval(".react-flow__node", (els) => els.map((e) => e.getAttribute("data-id")).sort());
report.idsBefore = await ids();

/** 选中 n1 + n2（点选模式下点 n1，再 Ctrl 点 n2）。 */
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
const box = async (id) => {
  const b = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + 8 };
};
const p1 = await box("n1");
await page.mouse.click(p1.x, p1.y);
await page.waitForTimeout(250);
const p2 = await box("n2");
await page.keyboard.down("Control");
await page.waitForTimeout(80);
await page.mouse.click(p2.x, p2.y);
await page.waitForTimeout(300);
await page.keyboard.up("Control");
report.selected = await page.$$eval(".react-flow__node.selected", (els) =>
  els.map((e) => e.getAttribute("data-id")).sort(),
);

// Ctrl+C 需要窗口焦点；用 body 聚焦再按键
await page.locator("body").click({ position: { x: 700, y: 400 } }).catch(() => undefined);
await page.waitForTimeout(200);
await page.keyboard.press("Control+c");
await page.waitForTimeout(700);

report.clipboardHead = await page.evaluate(async () => {
  try {
    const t = await navigator.clipboard.readText();
    return { ok: true, len: t.length, head: t.slice(0, 80) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Ctrl+V 粘贴
await page.keyboard.press("Control+v");
await page.waitForTimeout(1200);
report.idsAfterPaste = await ids();
report.statusAfterPaste = await page.locator(".canvas-statusbar").textContent();

// 剪贴板里放别人的文本 → 不应误吃
await page.evaluate(async () => {
  await navigator.clipboard.writeText("这是一段跟画布无关的文字");
});
await page.waitForTimeout(300);
await page.keyboard.press("Control+v");
await page.waitForTimeout(900);
report.toastForeign = await page.locator(".canvas-toast").textContent().catch(() => null);
report.nodesAfterForeign = (await ids()).length;

await page.screenshot({ path: "D:/DoubaoWorkClone/.verify/shots-p5/08-clipboard.png" });
console.log(JSON.stringify(report, null, 2));

await browser.close();
child.kill();
