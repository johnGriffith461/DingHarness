import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, pickPort, shot, waitForPort } from "./harness.mjs";

/**
 * 画布剪贴板端到端验收（PLAN 4.6）。
 *
 * 断言：选中两个节点 → Ctrl+C → 剪贴板里是带标记的 JSON；
 * Ctrl+V → 画布上多出这两个节点（id 已重排），且连线只保留内部那条；
 * 剪贴板里放别人的文本时，粘贴不会误吃（提示"剪贴板里不是画布内容"）。
 */
/*
 * ⚠️ 2026-10-16（审计 G01）：这里原来是 `"data"` —— 就是**仓库里那个真实数据目录**，
 * 而下面还有一句 `rmSync(DATA/canvas)`：每次跑这条验收都**删掉真实的画布文档**。
 * 现在落到 `.verify/` 下的专属目录（不进版本库、与真实数据无关）。
 */
const DATA = ".verify/data-clipboard";
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12380]);
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

await shot(page, ".verify/shots-p5/08-clipboard.png");
console.log(JSON.stringify(report, null, 2));

await browser.close();
child.kill();

/*
 * 判定（2026-10-13 补）：这条原来只有 `console.log(report)` —— 在批跑里等于"静默不测"
 * （复制没进剪贴板、粘贴没多出节点、甚至把别人的文本吃进去，它都照样退 0）。
 *
 * 断的是 PLAN 4.6 那三件后果：
 *   · 先真的选中了 n1 + n2 —— 否则后面几步全是空转（"静默少测"最常见的样子）
 *   · Ctrl+C 之后剪贴板里**是本程序的载荷**：开头 80 个字符里带
 *     `dsh-canvas-graph/v1` 这个格式标记（唯一的识别依据，见 `src/canvas/clipboard.ts`）
 *   · Ctrl+V 之后画布上正好**多出这两个节点**，原来的一个都没丢，且 id **没有重复**
 *     —— 粘贴会重排 id；不重排就会出现两个同 id 的节点，看着"多了一个"，其实是坏的
 *   · 剪贴板里放别人的文本再 Ctrl+V：**一个字都不许吃进去**（节点数不变），
 *     并且如实说一句「剪贴板里不是画布内容」（逐字）
 *
 * 为什么值得断：剪贴板是跨窗口、跨进程的入口，测不出来就只剩"手感"；
 * 而"误吃别人的文本"这种事在界面上只表现为"莫名其妙多了一个节点"。
 */
const bad = [];
const before = report.idsBefore ?? [];
const after = report.idsAfterPaste ?? [];

if ((report.selected ?? []).join(",") !== "n1,n2") {
  bad.push(`没选中 n1 + n2（实际 ${JSON.stringify(report.selected)}）—— 后面几步都没有对象`);
}
if (report.clipboardHead?.ok !== true) {
  bad.push(`读不到剪贴板：${JSON.stringify(report.clipboardHead?.error ?? report.clipboardHead)}`);
} else if (!String(report.clipboardHead.head ?? "").includes("dsh-canvas-graph/v1")) {
  bad.push(`剪贴板里不是画布载荷（头 80 个字符里没有格式标记）：${JSON.stringify(report.clipboardHead.head)}`);
}
if (after.length !== before.length + 2) bad.push(`粘贴后节点数不是 +2：${before.length} → ${after.length}`);
if (new Set(after).size !== after.length) bad.push(`粘贴后有重复的节点 id：${JSON.stringify(after)}（id 没重排）`);
for (const id of before) {
  if (!after.includes(id)) bad.push(`粘贴把原来的节点 ${id} 弄丢了`);
}
if (report.nodesAfterForeign !== after.length) {
  bad.push(`剪贴板里是别人的文字，节点数却变了：${after.length} → ${report.nodesAfterForeign}（误吃了别人的文本）`);
}
if (!String(report.toastForeign ?? "").includes("剪贴板里不是画布内容")) {
  bad.push(`粘别人的文本时没有如实提示：${JSON.stringify(report.toastForeign)}`);
}
if (bad.length) {
  console.error("✗ 画布剪贴板：" + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 画布剪贴板：复制进剪贴板的是带标记的载荷 / 粘贴 +2 且 id 重排不重复 / 别人的文本一个字没吃进去且有提示");
}
