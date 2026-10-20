import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, pickPort, shot, waitForPort, dismissFirstRunIfShown } from "./harness.mjs";

/**
 * 版本历史面板端到端验收（对标原版 `canvas_versions_*`）。
 *
 * 断言：
 *   1. 面板能列出磁盘上的历史版本，并标出"最新版本 = 当前"
 *   2. 预览某个历史版本 → 显示该版的节点/连线/标记数
 *   3. 点「恢复此版本」→ 画布内容真的回到那一版，且**修订号继续变大**（不回退）
 *   4. 恢复本身也会成为新的历史条目
 */

/*
 * ⚠️ 2026-10-16（审计 G01）：这里原来是 `"data"` —— 就是**仓库里那个真实数据目录**，
 * 而下面还有一句 `rmSync(DATA/canvas)`：每次跑这条验收都**删掉真实的画布文档**。
 * 现在落到 `.verify/` 下的专属目录（不进版本库、与真实数据无关）。
 */
const DATA = ".verify/data-versions";
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12360]);
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

const report = {};
const nodeCount = () => page.locator(".react-flow__node").count();

// 造三个版本：初始(6) → +1(7) → +2(8)
report.v0 = await nodeCount();
for (const kind of ["whiteboard", "mermaid"]) {
  await page.locator('[data-testid="add-node"]').click();
  await page.waitForTimeout(220);
  await page.locator(`.canvas-menu button[data-kind="${kind}"]`).click();
  await page.waitForTimeout(2000); // 等自动保存
}
report.currentNodes = await nodeCount();

// 打开版本历史
await page.locator('[data-testid="open-versions"]').click();
await page.waitForTimeout(600);
report.panelOpen = await page.locator('[data-testid="versions-panel"]').count();
report.latestLabel = await page.locator(".versions-item.is-latest .versions-item-name").textContent();
report.revisions = await page
  .locator('[data-testid="versions-list"] .versions-item:not(.is-latest) .versions-item-name')
  .allTextContents();

// 预览最老的一版（列表最后一个）
const buttons = page.locator('[data-testid^="version-preview-"]');
const n = await buttons.count();
report.previewButtons = n;
const oldestRev = (await buttons.last().getAttribute("data-testid"))?.replace("version-preview-", "");
await buttons.last().click();
await page.waitForTimeout(600);
report.previewText = (await page.locator('[data-testid="versions-preview"]').textContent()) ?? null;
report.oldestRev = oldestRev;

// 恢复到那一版
await page.locator(`[data-testid="version-restore-${oldestRev}"]`).click();
await page.waitForTimeout(2500);
report.afterRestoreNodes = await nodeCount();
report.noteAfterRestore = await page.locator(".versions-note").textContent().catch(() => null);
report.statusAfter = await page.locator(".canvas-statusbar").textContent();

// 恢复后历史里应该多出一条更大的修订号
await page.locator('[data-testid="open-versions"]').click();
await page.waitForTimeout(300);
await page.locator('[data-testid="open-versions"]').click();
await page.waitForTimeout(800);
report.revisionsAfterRestore = await page
  .locator('[data-testid="versions-list"] .versions-item:not(.is-latest) .versions-item-name')
  .allTextContents();

const doc = JSON.parse(fs.readFileSync(path.join(DATA, "canvas", "document.json"), "utf8"));
report.disk = { revision: doc.revision, nodes: doc.nodes.length, confirmed: doc.confirmedRevision };

await shot(page, ".verify/shots-p5/06-versions.png");
console.log(JSON.stringify(report, null, 2));

await browser.close();
child.kill();

/*
 * 判定（2026-10-13 补）：这条原来只有 `console.log(report)` —— 在批跑里等于"静默不测"。
 *
 * 断的是**版本历史这一路的四件后果**，全部落在脚本自己已经在读的字段上：
 *   ① 面板真开着，顶部那行写着「最新版本」（逐字，见 `VersionHistoryPanel.tsx`），
 *      历史里真的列出了磁盘上的修订，且"预览按钮数 == 列出的修订数"
 *   ② 点「预览」看到的是**点的那一版**，且预览里报的节点数 == 点「恢复此版本」之后
 *      画布上的节点数 —— "说的是哪一版"和"真换上去的内容"是同一版
 *   ③ 恢复后节点数**变少**（造过两个节点，回到更早的一版就该少）—— 恢复真的生效了
 *   ④ 恢复**不回退修订号**（把老内容写成一次更大的修订），且这次恢复自己进了历史列表
 *      —— 修订号必须单调，否则后续自动保存会被"修订号不能倒退"拒掉、界面卡在"保存失败"
 *
 * 为什么值得断：恢复错了（没换内容 / 换错了版本 / 把号改回去）在界面上都只是
 * "看着回去了"，只有把预览里的节点数、DOM 节点数、磁盘修订号摆在一起才分得清。
 */
const bad = [];
/** 「第 N 次修订」→ N（面板文案格式见 VersionHistoryPanel.tsx）。 */
const revNums = (list) =>
  (list ?? [])
    .map((s) => Number(/第 (\d+) 次修订/.exec(String(s ?? ""))?.[1] ?? NaN))
    .filter((n) => Number.isFinite(n));

if (report.panelOpen !== 1) bad.push("版本历史面板没打开（下面那些字段全是空的）");
if (report.latestLabel !== "最新版本") {
  bad.push(`面板顶部那一行不是「最新版本」：${JSON.stringify(report.latestLabel)}`);
}
const listed = revNums(report.revisions);
if (listed.length === 0) bad.push(`历史里一条修订都没列出来：${JSON.stringify(report.revisions)}`);
if (report.previewButtons !== (report.revisions ?? []).length) {
  bad.push(`预览按钮数与列出的修订数对不上：${report.previewButtons} vs ${(report.revisions ?? []).length}`);
}

const previewRev = Number(/第 (\d+) 次修订/.exec(report.previewText ?? "")?.[1] ?? NaN);
const previewNodes = Number(/节点 (\d+) 个/.exec(report.previewText ?? "")?.[1] ?? NaN);
if (previewRev !== Number(report.oldestRev)) {
  bad.push(`预览的不是点的那一版：预览第 ${previewRev} 次 / 按钮第 ${report.oldestRev} 次`);
}
if (!Number.isFinite(previewNodes)) {
  bad.push(`预览里读不到节点数：${JSON.stringify(report.previewText)}`);
}
if (report.afterRestoreNodes !== previewNodes) {
  bad.push(
    `恢复后画布上的节点数(${report.afterRestoreNodes}) ≠ 预览里那一版的节点数(${previewNodes}) —— 「恢复此版本」没真的换内容`,
  );
}
if (!(report.afterRestoreNodes < report.currentNodes)) {
  bad.push(`恢复后节点数没变少（${report.afterRestoreNodes} vs 造完两个节点后的 ${report.currentNodes}）—— 恢复没生效`);
}
if (!(report.disk?.revision > Number(report.oldestRev))) {
  bad.push(`恢复后磁盘修订号没往前走：disk.revision=${report.disk?.revision}（恢复的是第 ${report.oldestRev} 次）`);
}
if (!revNums(report.revisionsAfterRestore).includes(report.disk?.revision)) {
  bad.push(
    `这次恢复没进历史列表：磁盘上是第 ${report.disk?.revision} 次修订，列表里只有 ${JSON.stringify(report.revisionsAfterRestore)}`,
  );
}
if (bad.length) {
  console.error("✗ 版本历史：" + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 版本历史：面板列出磁盘上的修订 / 预览说的那一版就是恢复上去的内容 / 恢复不回退修订号且自己进历史");
}
