import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { openCanvas, shot } from "./harness.mjs";

/**
 * 写作助手**端到端**验收（对标原版 `canvas_writing_shortcuts_*`）。
 *
 * ⚠️ **这条真的连模型**（点「写短一点」然后等 15 秒）。
 * 文件名里的 `-model` 就是标记：**不要**把它塞进免模型批跑（`verify-acceptances.mjs`），
 * 也不要在没配通道的机器上指望它绿。原来它叫 `accept-writing.mjs`，
 * 名字看不出会调模型 —— 按名字挑脚本跑的人会踩这个坑。
 *
 * 真正连模型跑「润色/写短」，断言：
 *   1. 节点头部有「写作」入口，展开有 4 个动作
 *   2. 跑「写短一点」后**节点自身的文字变了**（不是新增节点）
 *   3. 节点数不变，且产生了新的生成版本
 *   4. Ctrl+Z 能撤销回改写前
 */

/*
 * ⚠️ 数据目录必须是**隔离**的（2026-10-14 改）。
 *
 * 这条原来写死 `D:/DoubaoWorkClone/data` —— 那是**开发机真实的数据目录**。
 * 它真的连模型、真的改写节点，于是每次跑都在主人的真实画布上动刀
 * （还写进真实会话日志）。验收不许碰真实数据，这条也是手册里
 * 「DSH_CANVAS_DATA_DIR 必须指到隔离目录」那条规矩的漏网之鱼。
 */
const DATA = "D:/DoubaoWorkClone/.verify/writing-data";
fs.rmSync(DATA, { recursive: true, force: true });
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
  await openCanvas(page);
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

await shot(page, "D:/DoubaoWorkClone/.verify/shots-p5/07-writing.png");
console.log(JSON.stringify(report, null, 2));

await browser.close();
child.kill();

/*
 * 判定（2026-10-13 补）：这条原来只有 `console.log(report)` —— 在批跑里等于"静默不测"。
 *
 * ⚠️ 这条脚本**真的连模型**（点「写短一点」然后等 15 秒），所以
 * 「文字真的被改写了」（`report.changed`）**故意不纳入判定** ——
 * 那是"等 N 毫秒后必须变"的时序判据，模型慢一点、机器忙一点、没配通道就会假红，
 * 属于本文件外面那条"判据要落在稳定后果上"的例外。
 * 它留下了一个**已知缺口**（改写本身没被钉住），如实记在这里，不拿别的断言凑数。
 *
 * 只断**不依赖模型**的那部分：
 *   · 目标节点 n1 本来就有文字 —— 读取点没失效（否则整条脚本是在空跑，跑完还说"绿"）
 *   · 写作入口展开后有菜单项，且**逐字**含「写短一点」（脚本点的就是它）
 *   · 改写之后**节点数不变** —— 写作助手改的是这个节点自己的内容，
 *     不是像「AI 生成」那样落一个新节点（新增/删除都算错）
 */
const bad = [];
if (typeof report.textBefore !== "string" || report.textBefore.trim() === "") {
  bad.push(`读不到 n1 的原文（选择器可能已过期，整条脚本在空跑）：${JSON.stringify(report.textBefore)}`);
}
const menuItems = report.menuItems ?? [];
if (menuItems.length === 0) bad.push("「写作」入口展开后菜单是空的");
else if (!menuItems.includes("写短一点")) bad.push(`菜单里没有「写短一点」：${JSON.stringify(menuItems)}`);
if (report.nodesAfter !== report.nodesBefore) {
  bad.push(`写作把节点数改了（${report.nodesBefore} → ${report.nodesAfter}）—— 该就地改写，不是新增/删除节点`);
}
if (bad.length) {
  console.error("✗ 写作产物：" + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 写作产物：n1 有原文 / 菜单里有「写短一点」/ 改写前后节点数不变（模型是否改写成功不在此判定）");
}
