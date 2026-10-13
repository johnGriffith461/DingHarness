import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 形状节点端到端验收（阶段 8.3）。
 *
 * 断言：
 *   1. 新建菜单里有矩形 / 椭圆两项
 *   2. 建出来之后 DOM 上带 `data-shape-kind="rect|ellipse"`（原版契约）
 *   3. 双击能写字，写完落到节点上
 *   4. 图层菜单里的翻转真的改变了 transform
 *   5. 形状随文档落盘、重启后还在
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

const report = {};
{
  const { child, browser, page } = await boot(9430);

  // 菜单里应有矩形 / 椭圆
  await page.locator('[data-testid="add-node"]').click();
  await page.waitForTimeout(300);
  report.menuKinds = await page.$$eval(".canvas-menu button[data-kind]", (els) =>
    els.map((e) => e.getAttribute("data-kind")),
  );
  await page.locator('.canvas-menu button[data-kind="rect"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="add-node"]').click();
  await page.waitForTimeout(300);
  await page.locator('.canvas-menu button[data-kind="ellipse"]').click();
  await page.waitForTimeout(2200);

  report.shapeKinds = await page.$$eval(".shape-node", (els) =>
    els.map((e) => e.getAttribute("data-shape-kind")),
  );
  report.shapeIds = await page.$$eval(".react-flow__node:has(.shape-node)", (els) =>
    els.map((e) => e.getAttribute("data-id")),
  );
  // 顺带量一下位置：级联错位有没有生效（两个形状不能完全重叠）
  report.shapeBoxes = await page.$$eval(".react-flow__node:has(.shape-node)", (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { id: e.getAttribute("data-id"), x: Math.round(r.x), y: Math.round(r.y) };
    }),
  );

  // 双击写字（用 dispatchEvent 直接派发一个原生 dblclick：
  // 绕开 React Flow 的命中测试，测的是形状自身的双击处理）
  const rectId = report.shapeIds[report.shapeKinds.indexOf("rect")];
  await page.locator(`.react-flow__node[data-id="${rectId}"] .shape-node`).dispatchEvent("dblclick");
  await page.waitForTimeout(500);
  const input = page.locator(`[data-testid="shape-input-${rectId}"]`);
  report.dblclickOpenedInput = await input.count();

  // 万一双击没开（例如被上层手势吞了），用显式按钮兜底 —— 这条路径必须可用
  if ((await input.count()) === 0) {
    report.dblclickFellBackToButton = true;
    await page.locator(`[data-testid="shape-edit-${rectId}"]`).click();
    await page.waitForTimeout(400);
  }
  report.inputAppeared = await page.locator(`[data-testid="shape-input-${rectId}"]`).count();
  await page.locator(`[data-testid="shape-input-${rectId}"]`).fill("产品主图");
  await page.locator(`[data-testid="shape-input-${rectId}"]`).press("Enter");
  await page.waitForTimeout(600);
  report.textAfterTyping = await page
    .locator(`.react-flow__node[data-id="${rectId}"] .shape-text`)
    .textContent();

  // 图层菜单里翻转
  await page.locator('[data-testid="open-layers"]').click();
  await page.waitForTimeout(600);
  await page.locator(`.layer-row[data-layer-id="${rectId}"]`).click({ button: "right" });
  await page.waitForTimeout(500);
  report.flipEnabled = !(await page.locator('[data-layer-op="flip-h"]').isDisabled());
  await page.locator('[data-layer-op="flip-h"]').click();
  await page.waitForTimeout(700);
  report.transformAfterFlip = await page.evaluate((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"] .shape-node`);
    return el ? getComputedStyle(el).transform : null;
  }, rectId);
  await page.screenshot({ path: "D:/DoubaoWorkClone/.verify/shots-final/shapes.png" });

  await page.waitForTimeout(1500);
  if (fs.existsSync(SNAP)) {
    const doc = JSON.parse(fs.readFileSync(SNAP, "utf8"));
    report.disk = {
      kinds: doc.nodes.map((n) => n.type),
      rect: doc.nodes.find((n) => n.type === "rect")?.data,
    };
  }
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2000));
}

// 重启看还在不在
{
  const { child, browser, page } = await boot(9431);
  report.afterRestart = {
    shapeKinds: await page.$$eval(".shape-node", (els) =>
      els.map((e) => e.getAttribute("data-shape-kind")),
    ),
    texts: await page.$$eval(".shape-text", (els) => els.map((e) => e.textContent)),
  };
  await browser.close();
  child.kill();
}

console.log(JSON.stringify(report, null, 2));
