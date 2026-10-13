import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { openCanvas, shot } from "./harness.mjs";

const OUT = "D:/DoubaoWorkClone/.verify/shots-p2";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath:
    "C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message.slice(0, 300)}`));

await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { timeout: 30000 });
await page.waitForTimeout(2500);

const r = {};
const nodeIds = await page.$$eval(".react-flow__node", (els) => els.map((e) => e.getAttribute("data-id")));
r.nodeIds = nodeIds;
r.nodeCount = nodeIds.length;

// 每种节点应出现的特征元素
r.features = await page.evaluate(() => ({
  markdownHtml: document.querySelectorAll(".nv-markdown-body h1").length,
  markdownList: document.querySelectorAll(".nv-markdown-body li").length,
  prismTokens: document.querySelectorAll(".nv-code-pre .token").length,
  mermaidSvg: document.querySelectorAll(".nv-mermaid-svg svg").length,
  mermaidNodes: document.querySelectorAll(".nv-mermaid-svg .node").length,
  markmapSvg: document.querySelectorAll(".nv-graph-svg").length,
  markmapNodes: document.querySelectorAll(".nv-graph-svg .markmap-node").length,
  boardCanvas: document.querySelectorAll(".nv-board-canvas").length,
  imageDrop: document.querySelectorAll(".nv-drop").length,
  handles: document.querySelectorAll(".react-flow__handle").length,
}));

await page.getByTitle("适配视图（一键全览）").click();
await page.waitForTimeout(1200);
await shot(page, `${OUT}/01-overview.png`);

// 节点类型菜单
await page.locator('[data-testid="add-node"]').click();
await page.waitForTimeout(300);
r.menuKinds = await page.$$eval(".canvas-add-menu button[data-kind]", (els) =>
  els.map((e) => e.getAttribute("data-kind")),
);
await shot(page, `${OUT}/02-add-menu.png`);
await page.keyboard.press("Escape");

// 新建白板并画一笔（在点选模式下）
const before = await page.evaluate(() => window.__canvasStore.getState().nodes.length);
await page.locator('[data-testid="add-node"]').click();
await page.waitForTimeout(200);
await page.locator('.canvas-add-menu button[data-kind="whiteboard"]').click();
await page.waitForTimeout(600);
const after = await page.evaluate(() => window.__canvasStore.getState().nodes.length);
r.addWhiteboard = { before, after };

// 找到新白板节点并绘制
const boardSel = ".react-flow__node:has(.nv-board-canvas)";
const boards = await page.locator(boardSel).count();
const canvasBox = await page.locator(boardSel).nth(boards - 1).locator(".nv-board-canvas").boundingBox();
if (canvasBox) {
  const cx = canvasBox.x + canvasBox.width / 2;
  const cy = canvasBox.y + canvasBox.height / 2;
  await page.mouse.move(cx - 60, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 30, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(900);
}
r.whiteboardStrokes = await page.evaluate(() => {
  const s = window.__canvasStore.getState();
  const wb = s.nodes.filter((n) => n.type === "whiteboard");
  return wb.map((n) => (n.data.strokes ?? []).length);
});
await shot(page, `${OUT}/03-whiteboard.png`);

// 编辑 Markdown：切到编辑态改内容，再切回预览
const mdNode = page.locator('.react-flow__node[data-id="n1"]');
const editBtn = mdNode.locator("button", { hasText: "编辑" });
if (await editBtn.count()) {
  await editBtn.first().click();
  await page.waitForTimeout(300);
  const ta = mdNode.locator("textarea");
  await ta.fill("# 改过的标题\n\n- 第一项\n- 第二项\n\n**粗体**与 `代码`");
  await page.waitForTimeout(700);
  const previewBtn = mdNode.locator("button", { hasText: "预览" });
  await previewBtn.first().click();
  await page.waitForTimeout(700);
}
r.markdownEdited = await page.evaluate(() => document.querySelector(".nv-markdown-body h1")?.textContent ?? null);
await shot(page, `${OUT}/04-markdown-edited.png`);

// 代码节点换语言：python
const codeSel = page.locator('.react-flow__node[data-id="n2"] select');
if (await codeSel.count()) {
  await codeSel.selectOption("python");
  await page.waitForTimeout(700);
}
r.codeLangTokens = await page.locator('.react-flow__node[data-id="n2"] .nv-code-pre .token').count();

// Mermaid 改源码触发重渲染
const mmTa = page.locator('.react-flow__node[data-id="n3"] textarea');
if (await mmTa.count()) {
  await mmTa.fill("pie title 节点类型占比\n  \"文本\" : 30\n  \"代码\" : 25\n  \"图表\" : 45");
  await page.waitForTimeout(1500);
}
r.mermaidAfterEdit = await page.evaluate(() => ({
  hasSvg: document.querySelectorAll(".nv-mermaid-svg svg").length,
  warn: document.querySelectorAll(".nv-warn").length,
}));
await shot(page, `${OUT}/05-mermaid-pie.png`);

// 导图改大纲
const mindTa = page.locator('.react-flow__node[data-id="n4"] textarea');
if (await mindTa.count()) {
  await mindTa.fill("# 新中心\n## A\n- a1\n- a2\n## B\n- b1\n### B1\n- b1a");
  await page.waitForTimeout(1600);
}
r.markmapNodes = await page.locator('.react-flow__node[data-id="n4"] .markmap-node').count();
await shot(page, `${OUT}/06-mindmap-edited.png`);

// 撤销 / 重做仍可用
await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
r.afterUndo = await page.evaluate(() => ({
  count: window.__canvasStore.getState().nodes.length,
  rev: window.__canvasStore.getState().revision,
}));
await page.keyboard.press("Control+Shift+z");
await page.waitForTimeout(400);
r.afterRedo = await page.evaluate(() => ({
  count: window.__canvasStore.getState().nodes.length,
  rev: window.__canvasStore.getState().revision,
}));

// 框选仍然工作
await page.locator('.canvas-mode[data-mode="box"]').click();
await page.waitForTimeout(250);
const geo = await page.evaluate(() => {
  const a = document.querySelector('.react-flow__node[data-id="n1"]').getBoundingClientRect();
  const b = document.querySelector('.react-flow__node[data-id="n2"]').getBoundingClientRect();
  return { from: { x: Math.max(5, a.x - 30), y: Math.max(45, a.y - 30) }, to: { x: b.x + b.width + 20, y: b.y + b.height + 20 } };
});
await page.mouse.move(geo.from.x, geo.from.y);
await page.mouse.down();
await page.mouse.move(geo.to.x, geo.to.y, { steps: 16 });
await page.waitForTimeout(200);
r.rubberBand = await page.locator(".sweep-rect").count();
await page.mouse.up();
await page.waitForTimeout(300);
r.boxSelected = await page.evaluate(() =>
  window.__canvasStore.getState().nodes.filter((n) => n.selected).map((n) => n.id),
);

await page.getByTitle("适配视图（一键全览）").click();
await page.waitForTimeout(1000);
await shot(page, `${OUT}/07-final.png`);

r.problems = problems;
console.log(JSON.stringify(r, null, 2));
await browser.close();
