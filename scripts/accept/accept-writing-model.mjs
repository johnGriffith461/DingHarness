import { chromium } from "playwright";
import {
  bootApp,
  connectWithRetry,
  failOnMarks,
  freshDir,
  killTree,
  openCanvas,
  pickPort,
  shot,
  verdict,
  waitForPage,
} from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来连 ✗ 都不印、也没有任何判定 —— 批跑里等于没测 */
failOnMarks();

/**
 * 写作助手**端到端**验收（对标原版 `canvas_writing_shortcuts_*`）。
 *
 * ⚠️ 这条**真的连模型**（点「写短一点」）。
 *
 * ⭐ **2026-10-16 收进批跑**（原来的头部写着"不要把它塞进免模型批跑"）。
 * 那句话成立的前提是"必须真模型才谈得上验"—— 而这一条真正要证的是
 * **模型吐出来的东西有没有被写回节点**（不是像「AI 生成」那样落一个新节点），
 * 假通道一样能驱动它（`bootApp` + 假通道 + 隔离数据目录）。
 * 顺带把"改写真的发生了"从**观察项**升成**判据**：原来 `report.changed`
 * 只打印不断言（理由是"等 15 秒再比"这种时序判据会假红）——
 * 现在等的条件是**确定的**（假通道那 3 秒一定流完），所以它可判了。
 *
 * 断言：
 *   1. 节点头部有「写作」入口，展开的菜单里**逐字**有「写短一点」
 *   2. 跑「写短一点」后**节点自身的文字变了**（模型输出真的写回去了）
 *   3. 节点数不变（就地改写，不是新增/删除节点）
 *   4. Ctrl+Z 能撤销回改写前
 *
 * ⚠️ 启动走 `bootApp`：原来自己 `spawn` + `waitForPort` + `connectOverCDP` ——
 * 这台机器上有「TCP 通、Electron 的调试服务器却不答」的端口区间，裸写法会卡死在连 CDP 那一步。
 */

/*
 * ⚠️ 数据目录必须是**隔离**的（2026-10-14 改）。
 *
 * 这条原来写死 `data` —— 那是**开发机真实的数据目录**。
 * 它真的连模型、真的改写节点，于是每次跑都在主人的真实画布上动刀
 * （还写进真实会话日志）。验收不许碰真实数据，这条也是手册里
 * 「DSH_CANVAS_DATA_DIR 必须指到隔离目录」那条规矩的漏网之鱼。
 */
const DATA = ".verify/writing-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const booted = await bootApp({ port: await pickPort([12370]), dataDir: DATA, timeoutMs: 40_000 });
if (!booted.ok) {
  console.error("[诊断] 应用输出尾部：" + (booted.getLog() || "(空)").slice(-1200));
  await killTree(booted.child);
  process.exit(1);
}
const browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
const page = await waitForPage(browser);
if (!page) throw new Error("应用起了但一个页面都没建（见 harness 的 NO_PAGE_HINT 说明）");
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

await shot(page, ".verify/shots-p5/07-writing.png");
console.log(JSON.stringify(report, null, 2));

await browser.close();
await killTree(booted.child);

/*
 * 判定（2026-10-13 补，2026-10-16 收进批跑时又加强了一档）。
 *
 * ⚠️ 这条脚本**真的连模型**（点「写短一点」），所以原来把
 * 「文字真的被改写了」（`report.changed`）**故意排除在判定之外** ——
 * 那是"等 N 毫秒后必须变"的时序判据，模型慢一点、机器忙一点、没配通道就会假红。
 *
 * ⭐ 2026-10-16：这条进了批跑（假通道那 3 秒一定流完，等待条件是确定的），
 * 于是 `changed` 从观察项升成**判据** —— 它正是这条验收最核心的那件事
 * （模型吐出来的东西有没有被写回这个节点）。剩下的断言照旧：
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
/* ⭐ 核心：改写真的落到节点文字上了（不是"点完什么都没发生还说通过"） */
if (!report.changed) {
  bad.push(
    `点了「写短一点」之后 n1 的文字没变（改写没写回去；写错误=${JSON.stringify(report.n1Html?.writeError)}，` +
      `生成条=${JSON.stringify(report.genbar)}）`,
  );
}
/* 撤销能回到改写前（用户点错了要有退路） */
if (!report.undoRestored) {
  bad.push(`Ctrl+Z 没有撤销回改写前（撤销后=${JSON.stringify((report.textAfterUndo ?? "").slice(0, 40))}）`);
}
verdict(bad, "写作产物：n1 有原文 / 菜单里有「写短一点」/ 模型输出真的写回节点且节点数不变 / Ctrl+Z 能撤销");
