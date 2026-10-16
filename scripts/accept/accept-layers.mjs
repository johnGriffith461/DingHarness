import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, pickPort, shot, waitForPort } from "./harness.mjs";

/**
 * 图层面板端到端验收（阶段 8.1 / 8.2）。
 *
 * 断言：
 *   1. 面板按 z 序列出全部图层（**从顶到底**，第一行是最上面那层）
 *   2. 点某行 → 该节点被选中
 *   3. 显隐 / 锁定按钮真的改到画布上（隐藏后 React Flow 里那个节点消失；锁定后不可拖）
 *   4. 右键 → 菜单出现，且「置顶/置底」在头尾时置灰
 *   5. 执行「置顶」后，DOM 里该节点排到最后（= 最上层）
 */

/*
 * ⚠️ 2026-10-16（审计 G01）：这里原来是 `"data"` —— 就是**仓库里那个真实数据目录**，
 * 而下面还有一句 `rmSync(DATA/canvas)`：每次跑这条验收都**删掉真实的画布文档**。
 * 现在落到 `.verify/` 下的专属目录（不进版本库、与真实数据无关）。
 */
const DATA = ".verify/data-layers";
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12420]);
const child = spawn(
  "node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: ".", env, stdio: ["ignore", "ignore", "ignore"] },
);
/* 固定等 8 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const report = {};
const domOrder = () =>
  page.$$eval(".react-flow__node", (els) => els.map((e) => e.getAttribute("data-id")));
const rowIds = () =>
  page.$$eval(".layer-row", (els) => els.map((e) => e.getAttribute("data-layer-id")));

report.domBefore = await domOrder();

// 打开图层面板
await page.locator('[data-testid="open-layers"]').click();
await page.waitForTimeout(600);
report.panelOpen = await page.locator('[data-testid="layer-panel"]').count();
report.rows = await rowIds();

/*
 * 2026-10-13 补：`layer-list` 这个 testid **原来没有任何脚本引用过**
 * （`src/` × `scripts/accept/` 交叉，见 HANDOFF §208 的零覆盖清单）。
 * 上面数的是 `.layer-row`（class），**列表容器本身**没人看过 —— 容器塌了/没渲染，
 * 光靠行数也可能"看起来没事"。这里断容器在、行数与它一致。
 */
report.layerList = await page.evaluate(() => {
  const box = document.querySelector('[data-testid="layer-list"]');
  return {
    count: box ? 1 : 0,
    rows: box ? box.querySelectorAll(".layer-row").length : 0,
    width: box ? Math.round(box.getBoundingClientRect().width) : null,
  };
});

// 点第二行 → 应选中它
const second = report.rows[1];
await page.locator(`.layer-row[data-layer-id="${second}"]`).click();
await page.waitForTimeout(350);
report.selectedAfterClick = await page.$$eval(".react-flow__node.selected", (els) =>
  els.map((e) => e.getAttribute("data-id")),
);

// 隐藏最后一层 → DOM 里应少一个节点
const toHide = report.rows[report.rows.length - 1];
await page.locator(`[data-layer-eye="${toHide}"]`).click();
await page.waitForTimeout(600);
report.domAfterHide = await domOrder();
report.hiddenGone = !report.domAfterHide.includes(toHide);
await page.locator(`[data-layer-eye="${toHide}"]`).click();
await page.waitForTimeout(600);

// 锁定第一层 → 该节点应变成不可拖动
const toLock = report.rows[0];
await page.locator(`[data-layer-lock="${toLock}"]`).click();
await page.waitForTimeout(500);
report.lockedDraggable = await page.evaluate((id) => {
  const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
  return el ? { cls: el.className, draggable: el.getAttribute("draggable") } : null;
}, toLock);
await page.locator(`[data-layer-lock="${toLock}"]`).click();
await page.waitForTimeout(400);

// 右键最后一行（最底层）→ 菜单；「置底」应置灰
const bottom = report.rows[report.rows.length - 1];
await page.locator(`.layer-row[data-layer-id="${bottom}"]`).click({ button: "right" });
await page.waitForTimeout(500);
report.menuOpen = await page.locator('[data-testid="layer-menu"]').count();
report.bottomMenuDisabled = {
  back: await page.locator('[data-layer-op="back"]').isDisabled(),
  backward: await page.locator('[data-layer-op="backward"]').isDisabled(),
  front: await page.locator('[data-layer-op="front"]').isDisabled(),
};

// 执行「置顶」
await page.locator('[data-layer-op="front"]').click();
await page.waitForTimeout(700);
report.domAfterFront = await domOrder();
report.frontWorked = report.domAfterFront[report.domAfterFront.length - 1] === bottom;
report.rowsAfterFront = await rowIds();

// 顶层的「置顶」应置灰
const top = report.rowsAfterFront[0];
await page.locator(`.layer-row[data-layer-id="${top}"]`).click({ button: "right" });
await page.waitForTimeout(500);
report.topMenuDisabledFront = await page.locator('[data-layer-op="front"]').isDisabled();
await page.locator('[data-layer-op="forward"]').isDisabled();
await shot(page, ".verify/shots-final/layers.png");

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();

/*
 * 2026-10-13 补：这条脚本**原来一条判定都没有**（只有 console.log(report)）——
 * 在批跑里等于"静默不测"（永远 exit 0）。这里只补**零覆盖那一组**（`layer-list` 容器）的判定，其余仍是报告。
 */
{
  const bad = [];
  if (report.layerList?.count !== 1) bad.push("图层面板里没有列表容器（layer-list）");
  if ((report.layerList?.rows ?? 0) !== (report.rows ?? []).length) {
    bad.push(`列表容器里的行数与面板行数不符：${report.layerList?.rows} vs ${(report.rows ?? []).length}`);
  }
  if ((report.layerList?.rows ?? 0) < 1) bad.push("列表容器是空的");
  if (!(report.layerList?.width > 100)) bad.push(`⭐ 图层列表被挤塌了（宽 ${report.layerList?.width}px）`);
  if (bad.length) {
    console.error("✗ 零覆盖那一组（图层列表容器）：" + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 零覆盖那一组成立：图层面板有列表容器，行数与面板一致，宽度正常");
  }
}
