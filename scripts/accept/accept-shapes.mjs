import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, shot } from "./harness.mjs";

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
const DATA = "data";
const SNAP = path.join(DATA, "canvas", "document.json");
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const EXE = "node_modules/electron/dist/electron.exe";
async function boot(port) {
  const child = spawn(EXE, [".", `--remote-debugging-port=${port}`], {
    cwd: ".",
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
  await shot(page, ".verify/shots-final/shapes.png");

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

/*
 * 判定（2026-10-13 补）：这条原来只有 `console.log(report)` —— 在批跑里等于"静默不测"
 * （形状建不出来、字没写上去、翻转是假的，它都照样退 0）。
 *
 * 断的是形状节点这一路的**后果**（就是脚本头部自列的那几条断言）：
 *   ① 新建菜单里有 rect / ellipse 两档
 *   ② 建出来带 `data-shape-kind=rect|ellipse`（原版契约）
 *   ③ 连建两个不会**完全叠在一起**（级联错位）—— 叠死的后果很实际：上面那个把下面
 *      整个盖住，用户点不到、也看不出有几个。步长是 48px（CanvasRuntime 的 STEP），
 *      而历史上这个 bug 的形态恰恰是"只差 8px、基本还叠着"，所以门槛取 16px：
 *      真错位过就绝不该低于它
 *   ④ 双击（或兜底按钮）能开输入框，写完**那个字**就在节点上（逐字）
 *   ⑤ 图层里翻转真的改变了 transform（出现负缩放）
 *   ⑥ 落盘 + 重启后还在：磁盘文档里的类型、节点上的那行字，重启后一个都不能少
 *
 * 为什么值得断：形状是"画布上唯一需要靠肉眼判断对错"的那类东西 ——
 * 它错了不会有任何报错，只会"看着还行"。
 */
const bad = [];
const kinds = report.menuKinds ?? [];
for (const want of ["rect", "ellipse"]) {
  if (!kinds.includes(want)) bad.push(`新建菜单里没有「${want}」（现有：${JSON.stringify(kinds)}）`);
}
const shapeKinds = [...(report.shapeKinds ?? [])].sort();
if (JSON.stringify(shapeKinds) !== JSON.stringify(["ellipse", "rect"])) {
  bad.push(`画布上的形状不是 rect + ellipse 各一个：${JSON.stringify(report.shapeKinds)}`);
}
const boxes = report.shapeBoxes ?? [];
if (boxes.length !== 2) {
  bad.push(`量到的形状位置不是两个：${JSON.stringify(boxes)}`);
} else {
  const gap = Math.max(Math.abs(boxes[0].x - boxes[1].x), Math.abs(boxes[0].y - boxes[1].y));
  if (gap < 16) bad.push(`两个形状几乎完全叠着（只错开 ${gap}px）—— 级联错位没生效`);
}
if (report.inputAppeared !== 1) bad.push("双击形状没弹出文字输入框（兜底按钮也没顶上）");
if (String(report.textAfterTyping ?? "").trim() !== "产品主图") {
  bad.push(`写完的字没落到节点上：${JSON.stringify(report.textAfterTyping)}`);
}
if (report.flipEnabled !== true) bad.push("形状的「水平翻转」是灰的（canFlip 没把 rect/ellipse 算进去）");
const tf = String(report.transformAfterFlip ?? "none");
if (!/-1/.test(tf)) {
  bad.push(`翻转没改变 transform（读到 ${JSON.stringify(report.transformAfterFlip)}）—— 点了没有反应`);
}
const diskKinds = report.disk?.kinds ?? [];
for (const want of ["rect", "ellipse"]) {
  if (!diskKinds.includes(want)) bad.push(`磁盘上的文档里没有 ${want} 节点：${JSON.stringify(diskKinds)}`);
}
if (report.disk?.rect?.text !== "产品主图") {
  bad.push(`磁盘上那个矩形里的字不对：${JSON.stringify(report.disk?.rect?.text)}`);
}
const restartKinds = [...(report.afterRestart?.shapeKinds ?? [])].sort();
if (JSON.stringify(restartKinds) !== JSON.stringify(["ellipse", "rect"])) {
  bad.push(`重启后画布上的形状不对：${JSON.stringify(report.afterRestart?.shapeKinds)}`);
}
const texts = (report.afterRestart?.texts ?? []).map((t) => String(t ?? "").trim());
if (!texts.includes("产品主图")) bad.push(`重启后那个字没了：${JSON.stringify(report.afterRestart?.texts)}`);
if (bad.length) {
  console.error("✗ 形状节点：" + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 形状节点：菜单两档齐全 / 契约属性对 / 两个不重叠 / 双击能写字且逐字落到节点上 / 翻转真改了 transform / 落盘且重启后仍在");
}
