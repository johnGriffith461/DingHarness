import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "D:/DoubaoWorkClone/.verify/shots-final";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath:
    "C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));

await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node");
await page.waitForTimeout(700);

const st = () =>
  page.evaluate(() => {
    const s = window.__canvasStore.getState();
    const m = /matrix\(([\d.]+), 0, 0, [\d.]+, ([-\d.]+), ([-\d.]+)\)/.exec(
      getComputedStyle(document.querySelector(".react-flow__viewport")).transform,
    );
    return {
      mode: document.querySelector(".canvas-root")?.getAttribute("data-selection-mode"),
      selected: s.nodes.filter((n) => n.selected).map((n) => n.id),
      ids: s.nodes.map((n) => n.id),
      pos: Object.fromEntries(s.nodes.map((n) => [n.id, [n.position.x, n.position.y]])),
      count: s.nodes.length,
      edges: s.edges.length,
      rev: s.revision,
      zoom: m ? Number(m[1]) : 1,
    };
  });

/** 用页面内坐标取节点矩形（与 elementFromPoint 同一坐标系）。 */
const rects = () =>
  page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll(".react-flow__node")) {
      const r = el.getBoundingClientRect();
      out[el.getAttribute("data-id")] = { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }
    return out;
  });
const center = async (id) => {
  const r = (await rects())[id];
  return { x: r.cx, y: r.cy };
};
const header = async (id) => {
  const r = (await rects())[id];
  return { x: r.x + r.w / 2, y: r.y + 9 };
};
const drag = async (fr, to, steps = 16) => {
  await page.mouse.move(fr.x, fr.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(280);
};
/** 画布内一块不属于任何节点的空地（从节点矩形外找）。 */
const blank = async () => {
  const r = await rects();
  const list = Object.values(r);
  for (let y = 100; y < 880; y += 15) {
    for (let x = 310; x < 1430; x += 15) {
      if (list.some((b) => x >= b.x - 14 && x <= b.x + b.w + 14 && y >= b.y - 14 && y <= b.y + b.h + 14)) continue;
      const inCanvas = await page.evaluate(
        ([px, py]) => {
          const el = document.elementFromPoint(px, py);
          return Boolean(el?.closest(".canvas-flow")) && !el?.closest(".react-flow__node");
        },
        [x, y],
      );
      if (inCanvas) return { x, y };
    }
  }
  throw new Error("找不到空白点");
};

const r = {};
r.init = await st();

/* 1. 框选：从空白起手，框住 n1+n2（n3 在下方不入选） */
{
  await page.locator('.canvas-mode[data-mode="box"]').click();
  await page.waitForTimeout(250);
  const b = await rects();
  const from = await blank();
  const to = { x: b.n2.x + b.n2.w + 20, y: b.n1.y + b.n1.h + 20 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 40, { steps: 4 });
  await page.waitForTimeout(140);
  const rectCount = await page.locator(".sweep-rect").count();
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await page.waitForTimeout(140);
  const w = await page.locator(".sweep-rect").getAttribute("width").catch(() => null);
  const during = (await st()).selected;
  await page.screenshot({ path: `${OUT}/01-box-during.png` });
  await page.mouse.up();
  await page.waitForTimeout(280);
  r.box = {
    rubberBand: rectCount === 1,
    rectWidth: w ? Math.round(Number(w)) : null,
    selectedDuring: during,
    cleared: (await page.locator(".sweep-rect").count()) === 0,
    selected: (await st()).selected,
  };
  await page.screenshot({ path: `${OUT}/02-box-result.png` });
}

/* 2. 框选模式下拖节点（起手在 header 上，应放行给 React Flow） */
{
  const before = (await st()).pos.n1;
  const h = await header("n1");
  await drag(h, { x: h.x + 160, y: h.y + 110 });
  const s = await st();
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  r.dragInBoxMode = {
    moved: JSON.stringify(s.pos.n1) !== JSON.stringify(before),
    newPos: s.pos.n1,
    undoBack: JSON.stringify((await st()).pos.n1) === JSON.stringify(before),
  };
}

/* 3. 涂抹选：从 n1 中心划到 n3 中心 */
{
  await page.locator('.canvas-mode[data-mode="smear"]').click();
  await page.waitForTimeout(250);
  const n1 = await center("n1");
  const n2 = await center("n2");
  const n3 = await center("n3");
  await page.mouse.move(n1.x, n1.y);
  await page.mouse.down();
  await page.mouse.move(n2.x, n2.y, { steps: 12 });
  await page.waitForTimeout(160);
  const mid = await page.locator(".smear-trail").count();
  await page.mouse.move(n3.x, n3.y, { steps: 12 });
  await page.waitForTimeout(160);
  const pts = await page.locator(".smear-trail").getAttribute("points").catch(() => null);
  const during = (await st()).selected;
  await page.screenshot({ path: `${OUT}/03-smear-during.png` });
  await page.mouse.up();
  await page.waitForTimeout(280);
  r.smear = {
    trailDrawn: mid === 1,
    points: pts ? pts.split(" ").length : 0,
    selectedDuring: during,
    cleared: (await page.locator(".smear-trail").count()) === 0,
    selected: (await st()).selected,
  };
  await page.screenshot({ path: `${OUT}/04-smear-result.png` });
}

/* 4. 点选：点节点选中、点空白清空 */
{
  await page.locator('.canvas-mode[data-mode="point"]').click();
  await page.waitForTimeout(250);
  const c = await center("n3");
  await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(250);
  const afterNode = (await st()).selected;
  const b = await blank();
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(280);
  r.point = { afterNode, afterBlank: (await st()).selected };
}

/* 5. 平移模式 */
{
  await page.locator('.canvas-mode[data-mode="pan"]').click();
  await page.waitForTimeout(250);
  const before = await page.evaluate(
    () => getComputedStyle(document.querySelector(".react-flow__viewport")).transform,
  );
  const b = await blank();
  await drag(b, { x: b.x - 140, y: b.y - 100 }, 14);
  const after = await page.evaluate(
    () => getComputedStyle(document.querySelector(".react-flow__viewport")).transform,
  );
  r.pan = { moved: before !== after, before, after };
  await page.getByTitle("适配视图（一键全览）").click();
  await page.waitForTimeout(500);
}

/* 6. 网格吸附：世界位移 = 屏幕位移 / zoom */
{
  await page.locator('.canvas-mode[data-mode="point"]').click();
  await page.waitForTimeout(250);
  const s0 = await st();
  const h = await header("n2");
  const before = s0.pos.n2;
  const dx = 173;
  const dy = 119;
  await drag(h, { x: h.x + dx, y: h.y + dy }, 18);
  const s1 = await st();
  const expected = [
    Math.round((before[0] + dx / s0.zoom) / 16) * 16,
    Math.round((before[1] + dy / s0.zoom) / 16) * 16,
  ];
  r.gridSnap = {
    zoom: Number(s0.zoom.toFixed(4)),
    before,
    after: s1.pos.n2,
    expected,
    snapped16: s1.pos.n2[0] % 16 === 0 && s1.pos.n2[1] % 16 === 0,
    matches: Math.abs(s1.pos.n2[0] - expected[0]) <= 16 && Math.abs(s1.pos.n2[1] - expected[1]) <= 16,
  };
}

/* 7. 文本编辑（点选模式，含 pangu 待接） */
{
  const ta = page.locator('.react-flow__node[data-id="n1"] textarea');
  await ta.click();
  await ta.fill("阶段 1 验收：文本可编辑");
  await page.waitForTimeout(900);
  r.text = { value: await ta.inputValue() };
}

/* 8. 代码语言切换 */
{
  const sel = page.locator('.react-flow__node[data-id="n2"] select');
  const before = await sel.inputValue();
  await sel.selectOption("python");
  await page.waitForTimeout(280);
  r.codeLang = { before, after: await sel.inputValue() };
}

/* 9. 新建 → id 唯一 → 全选 → 删除 → 撤销 */
{
  await page.getByTitle("在视口中心新建文本节点").click();
  await page.waitForTimeout(320);
  const s = await st();
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(250);
  const all = (await st()).selected.length;
  await page.keyboard.press("Delete");
  await page.waitForTimeout(320);
  const cleared = (await st()).count;
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(340);
  r.crud = {
    ids: s.ids,
    uniqueIds: new Set(s.ids).size === s.ids.length,
    domNodes: await page.locator(".react-flow__node").count(),
    allSelected: all,
    cleared,
    restored: (await st()).count,
  };
}

/* 10. 重置 + 最终全览 */
{
  await page.getByTitle("回到示例画布").click();
  await page.waitForTimeout(400);
  const s = await st();
  r.reset = { count: s.count, ids: s.ids, pos: s.pos };
  await page.locator('.canvas-mode[data-mode="box"]').click();
  await page.getByTitle("适配视图（一键全览）").click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/05-final.png` });
}

r.problems = problems;
console.log(JSON.stringify(r, null, 2));
await browser.close();
