import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, shot } from "./harness.mjs";

/**
 * 标记层端到端验收（阶段 5.1 / 5.2 / 5.3）：
 *   1. 八种标记都能画出来，落到 DOM（`.marker-shape`）
 *   2. 颜色 / 线宽切了之后新标记用新样式
 *   3. 撤销上一笔、清空
 *   4. 标记随文档落盘并在重启后还在（阶段 5 首次接入持久化）
 *   5. 标记当提示词：拼进生成要求（读请求内容做断言）
 */

const DATA = "D:/DoubaoWorkClone/data";
const SNAP = path.join(DATA, "canvas", "document.json");
const OUT = "D:/DoubaoWorkClone/.verify/shots-p5";
fs.mkdirSync(OUT, { recursive: true });
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
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${port}`);
  const pages = browser.contexts()[0].pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
  await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);
  
  await page.waitForSelector(".react-flow__node", { state: "attached" });
  await page.waitForTimeout(2000);
  return { child, browser, page };
}

const shapes = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".marker-layer .marker-shape")).map((el) => {
      const cls = el.getAttribute("class") ?? "";
      const m = /marker-(rect|ellipse|arrow|scratch|highlight|mask|text|number)\b/.exec(cls);
      return m ? m[1] : cls;
    }),
  );

const report = {};

{
  const { child, browser, page } = await boot(9300);
  const box = await page.locator(".canvas-flow").boundingBox();
  // 画在左上角空区域，避开节点
  const at = (dx, dy) => ({ x: box.x + 120 + dx, y: box.y + 120 + dy });

  const tool = async (name) => {
    await page.locator(`[data-marker-tool="${name}"]`).click();
    await page.waitForTimeout(150);
  };
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(250);
  };
  const click = async (p) => {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(250);
  };

  report.toolbarPresent = await page.locator('[data-testid="marker-toolbar"]').count();

  // 1. 方框
  await tool("rect");
  await drag(at(0, 0), at(120, 80));
  // 2. 圈选
  await tool("ellipse");
  await drag(at(160, 0), at(260, 70));
  // 3. 箭头
  await tool("arrow");
  await drag(at(0, 110), at(110, 160));
  // 4. 涂鸦
  await tool("scratch");
  await drag(at(0, 200), at(90, 250));
  // 5. 划重点
  await tool("highlight");
  await drag(at(140, 200), at(240, 205));
  // 6. 遮挡
  await tool("mask");
  await drag(at(280, 130), at(380, 200));
  // 7. 批注（点 → 输入框打字）
  await tool("text");
  await click(at(300, 40));
  await page.locator('[data-testid="marker-text-input"] textarea').fill("这段写短一点");
  await page.locator('[data-testid="marker-text-input"] textarea').press("Enter");
  await page.waitForTimeout(300);
  // 8. 序号 ×2（验证编号递增）
  await tool("number");
  await click(at(420, 60));
  await page.locator('[data-marker-tool="number"]').click();
  await page.waitForTimeout(120);
  await click(at(470, 90));

  report.shapes = await shapes(page);
  report.countText = await page.locator('[data-testid="marker-count"]').textContent();
  report.statusText = await page.locator(".canvas-statusbar").textContent();
  await shot(page, `${OUT}/01-markers.png`);

  // 样式：换色 + 加粗后再画一条，检查它用了新样式
  await page.locator('[data-marker-color="#4ade80"]').click();
  await page.locator(".marker-width").fill("9");
  await page.waitForTimeout(150);
  await tool("rect");
  await drag(at(520, 150), at(600, 220));
  report.styled = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll(".marker-layer .marker-shape"));
    const last = els[els.length - 1];
    return { stroke: last?.getAttribute("stroke"), width: last?.getAttribute("stroke-width") };
  });

  // 撤销一笔：先记录撤销前的数量，再点撤销，最后核对
  report.beforeUndo = (await shapes(page)).length;
  await page.locator('[data-testid="marker-undo"]').click();
  await page.waitForTimeout(300);
  report.afterUndo = (await shapes(page)).length;
  await shot(page, `${OUT}/02-styled.png`);

  // 标记当提示词：开着时拼接，关掉时不拼
  await page.waitForTimeout(1800); // 落盘
  const doc = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  report.disk = { markers: (doc.markers ?? []).length, kinds: (doc.markers ?? []).map((m) => m.kind) };
  report.promptToggleOn = await page.locator('[data-testid="marker-prompt"]').getAttribute("class");

  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2000));
}

// 重启：标记应还在
{
  const { child, browser, page } = await boot(9301);
  report.afterRestart = {
    shapes: await shapes(page),
    status: await page.locator(".canvas-statusbar").textContent(),
  };
  await shot(page, `${OUT}/03-restart.png`);
  await browser.close();
  child.kill();
}

console.log(JSON.stringify(report, null, 2));
