import { chromium } from "playwright";
import { spawn } from "node:child_process";

/**
 * 写作助手端到端验收（对标原版 `canvas_writing_shortcuts_*`）。
 *
 * 真正连模型跑「润色/写短」，断言：
 *   1. 节点头部有「写作」入口，展开有 4 个动作
 *   2. 跑「写短一点」后**节点自身的文字变了**（不是新增节点）
 *   3. 节点数不变，且产生了新的生成版本
 *   4. Ctrl+Z 能撤销回改写前
 */

const DATA = "D:/DoubaoWorkClone/data";
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9370"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9370");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const report = {};
const before = await page.locator(".react-flow__node").count();
report.nodesBefore = before;

const textOf = () =>
  page.evaluate(() => {
    const node = document.querySelector(".react-flow__node[data-id='n1']");
    if (!node) return null;
    // 节点可能是编辑态（textarea）或预览态（渲染后的 div），两种都读
    const ta = node.querySelector("textarea");
    if (ta) return ta.value;
    const body = node.querySelector(".nv-markdown-body");
    return body ? (body.textContent ?? "").trim() : null;
  });

report.textBefore = await textOf();

// 打开 n1 的写作菜单
await page.locator('[data-testid="writing-entry-n1"]').click();
await page.waitForTimeout(400);
report.menuItems = await page.locator('[data-testid="writing-menu-n1"] .nv-menu-item').allTextContents();

// 跑「写短一点」
await page.locator('[data-writing-action="shorter"]').click();
await page.waitForTimeout(15000);

report.textAfter = await textOf();
report.nodesAfter = await page.locator(".react-flow__node").count();
report.changed = report.textBefore !== report.textAfter;
report.genbar = await page
  .locator(".react-flow__node[data-id='n1'] .nv-genbar")
  .textContent()
  .catch(() => null);
report.ids = await page.$$eval(".react-flow__node", (els) => els.map((e) => e.getAttribute("data-id")));
report.n1Html = await page.evaluate(() => {
  const n = document.querySelector(".react-flow__node[data-id='n1']");
  if (!n) return "(找不到 n1)";
  return {
    cls: n.className,
    writeError: n.querySelector(".nv-write-error")?.textContent ?? null,
    genbar: n.querySelector(".nv-genbar")?.textContent ?? null,
    bodyLen: n.querySelector(".nv-markdown-body")?.textContent?.length ?? null,
    hasTextarea: Boolean(n.querySelector("textarea")),
    head: n.querySelector(".nv-head")?.textContent ?? null,
    htmlSlice: n.innerHTML.slice(0, 400),
  };
});

// Ctrl+Z 撤销
await page.locator(".react-flow__node[data-id='n1']").click({ position: { x: 40, y: 8 } });
await page.waitForTimeout(300);
await page.keyboard.press("Control+z");
await page.waitForTimeout(900);
report.textAfterUndo = await textOf();
report.undoRestored = report.textAfterUndo === report.textBefore;

await page.screenshot({ path: "D:/DoubaoWorkClone/.verify/shots-p5/07-writing.png" });
console.log(JSON.stringify(report, null, 2));

await browser.close();
child.kill();
