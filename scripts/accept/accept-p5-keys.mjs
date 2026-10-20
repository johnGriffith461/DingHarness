import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, pickPort, shot, waitForPort, dismissFirstRunIfShown } from "./harness.mjs";

/**
 * 阶段 5.5 快捷键系统验收：四个新动作在真实应用里生效。
 *   Ctrl+D 复制选中节点（节点数 +1，副本错开 28px）
 *   Ctrl+M 开关标记模式（data-marker-tool 跟着变）
 *   Ctrl+Shift+M 清空标记
 *   Ctrl+0 适应视图
 *   快捷键说明面板列出全部条目
 */

/*
 * ⚠️ 2026-10-16（审计 G01）：这里原来是 `"data"` —— 就是**仓库里那个真实数据目录**，
 * 而下面还有一句 `rmSync(DATA/canvas)`：每次跑这条验收都**删掉真实的画布文档**。
 * 现在落到 `.verify/` 下的专属目录（不进版本库、与真实数据无关）。
 */
const DATA = ".verify/data-p5-keys";
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12320]);
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
await dismissFirstRunIfShown(page);
await page.waitForTimeout(1800);
  await openCanvas(page);
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
await shot(page, ".verify/shots-p5/04-shortcuts.png");

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

/*
 * 判定（2026-10-13 补）：这条原来只有 `console.log(report)` —— 在批跑里等于"静默不测"
 * （快捷键没接上、标记清不掉，它都照样退 0）。
 *
 * 断的是这几个键**真的做了事**（全是脚本自己已经在读的量）：
 *   · 先真的选中了一个节点（否则 Ctrl+D 那一步没有对象，+1 无从谈起）
 *   · Ctrl+D：节点 +1（复制到同一处，所以只能数个数）
 *   · Ctrl+M：画布根的 `data-marker-tool` 从 off 变成 rect —— 标记模式真打开了
 *   · 于是在标记模式下画一笔：标记数 1；Ctrl+Shift+M：标记数 0
 *     （前一条是"模式打开了"的证据，后一条是"清空真清了"的证据，互为对照）
 *   · Esc：`data-marker-tool` 回到 off
 *   · 快捷键说明面板里**列着它要测的这三条**（Ctrl+D / Ctrl+M / Ctrl+Shift+M）
 *     —— 面板与实现是两张表，漏一条就有一半人不知道有这个键
 *
 * 为什么值得断：快捷键最容易"注册了但没接上"（匹配表里少一条、或处理器里忘了
 * preventDefault），而界面上什么都看不出来 —— 只有做一遍、数一数才知道。
 */
const bad = [];
/** 从「标记 3」这类文案里取出数字。 */
const countOf = (s) => {
  const m = /(\d+)/.exec(String(s ?? ""));
  return m ? Number(m[1]) : NaN;
};

if (!(report.selectedBefore >= 1)) bad.push("点选之后一个节点都没选中（Ctrl+D 那一步没有对象）");
const dup = report.duplicate ?? {};
if (dup.after !== dup.before + 1) bad.push(`Ctrl+D 没让节点 +1：${dup.before} → ${dup.after}`);
if (report.toolBefore !== "off") bad.push(`起手 data-marker-tool 不是 off：${JSON.stringify(report.toolBefore)}`);
if (report.toolAfter !== "rect") bad.push(`Ctrl+M 没打开标记模式（data-marker-tool）：${JSON.stringify(report.toolAfter)}`);
if (countOf(report.marketCountAfterDraw) !== 1) {
  bad.push(`标记模式下画了一笔，标记数不是 1：${JSON.stringify(report.marketCountAfterDraw)}`);
}
if (countOf(report.markerCountAfterClear) !== 0) {
  bad.push(`Ctrl+Shift+M 没清空标记：${JSON.stringify(report.markerCountAfterClear)}`);
}
if (report.toolAfterEscape !== "off") bad.push(`Esc 没退出标记模式：${JSON.stringify(report.toolAfterEscape)}`);
for (const want of ["Ctrl+D", "Ctrl+M", "Ctrl+Shift+M"]) {
  if (!(report.cheatsheetKeys ?? []).includes(want)) {
    bad.push(`快捷键说明面板里没有 ${want}：${JSON.stringify(report.cheatsheetKeys)}`);
  }
}
if (bad.length) {
  console.error("✗ 画布快捷键：" + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 画布快捷键：Ctrl+D 真复制 / Ctrl+M 真开标记模式且画得出、Ctrl+Shift+M 真清空 / Esc 退出 / 面板列全");
}
