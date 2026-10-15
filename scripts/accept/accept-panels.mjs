// 右侧两个面板：开、关、反复开合、Esc —— M0 工单 2 的常驻回归。
//
// 判据来自工单 2.2 / 2.3：
//   · 关闭入口必须**可见且语义无歧义**（带字或公认图标）
//   · 两个右面板统一支持 **Esc 关闭**（键盘可达）
//   · 开、关、反复开合各 10 次，行为一致，无"关不掉"状态
//   · 把手类开关的热区**不得被吞**（10-14 在这种地方出过两次布局回归）
//
// ⚠️ 修前实测（2026-10-15，`.verify/m0/probe-panels.mjs`）留下的三条事实，别当成主张删掉：
//   ① 摘要面板**本来就能关**（10-14 那版已修：收起按钮带字「收起」）——它缺的只有 Esc；
//   ② 画布对话侧栏的把手**热区没被吞**（`elementFromPoint` 命中的就是它自己）、10 次开合一致；
//      它真正的毛病是**关的入口只有一颗 17px 的 `‹`** —— 像"往左导航"、容易看漏；
//   ③ 所以这一条的断言落在"入口可见/带字 + Esc + 往返一致"，不是"修一个关不掉的 bug"。
import { chromium } from "playwright";
import { openApp, sleep, killLeftovers, pickPort, openCanvas, openSummary } from "./harness.mjs";

const bad = [];
const note = (m) => console.log("   " + m);

const port = await pickPort([9881]);
await killLeftovers();
const { browser, page } = await openApp(chromium, {
  port,
  dataDir: ".verify/accept-panels-data",
  cwd: ".",
});
await sleep(1800);

/** 面板 A 的状态。 */
const summaryState = () =>
  page.evaluate(() => {
    const aside = document.querySelector('[data-testid="wb-summary"]');
    const btn = document.querySelector('[data-testid="wb-summary-collapse"]');
    return {
      collapsed: aside ? aside.classList.contains("is-collapsed") : null,
      handle: Boolean(document.querySelector('[data-testid="wb-summary-expand"]')),
      collapseBtn: Boolean(btn),
      collapseText: (btn?.textContent ?? "").trim(),
    };
  });

/* ---------- 面板 A：对话摘要 ---------- */

const a0 = await summaryState();
if (a0.collapsed !== true) bad.push("摘要面板默认应当收起");
if (!a0.handle) bad.push("摘要面板收起时没有展开的浮标（那就打不开了）");
await openSummary(page);
const a1 = await summaryState();
if (a1.collapsed) bad.push("点浮标后摘要面板没有展开");
if (!a1.collapseBtn) bad.push("摘要面板展开后没有「收起」入口");
if (!/收起/.test(a1.collapseText)) {
  bad.push(`摘要面板的收起入口不带字（实测文字=「${a1.collapseText}」）—— 用户会认成"往右导航"`);
}

/*
 * 左缘那条**竖排「收起」**（2026-10-16，主人报的）：
 *   「点面板是打开，但打开之后根本没有显示关闭的面板按钮；打开画布又有了，
 *     有了之后你会发现它的面板按钮还在最右侧，没有跟着侧边栏动。」
 * 收起态那颗「面板」把手点了能打开，打开之后**原位没有对应的收起**。
 * 判据三条：① 展开时它必须在；② 必须带字（图标 + 「收起」）；
 *          ③ 它得**贴住面板左缘**（edge.right ≈ panel.x）—— 面板挪到哪，它跟到哪。
 * 第 ③ 条是"跟着侧边栏动"的可测形态：把窗口改窄，再量一次。
 */
const edgeState = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-summary-edge"]');
    const panel = document.querySelector('[data-testid="wb-summary"]');
    if (!el || !panel) return { edge: null, panel: panel ? 1 : 0 };
    const e = el.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    return {
      edge: { right: Math.round(e.x + e.width), w: Math.round(e.width) },
      panelX: Math.round(p.x),
      text: (el.textContent ?? "").replace(/\s+/g, "").trim(),
      vertical: Math.abs(e.y + e.height / 2 - (p.y + p.height / 2)) <= 2,
    };
  });
const e1 = await edgeState();
if (!e1.edge) bad.push("摘要面板展开后，左缘没有竖排「收起」（关的入口只在头上那颗）");
else {
  if (!/收起/.test(e1.text)) bad.push(`左缘那条收起不带字（实测=「${e1.text}」）`);
  if (Math.abs(e1.edge.right - e1.panelX) > 2) {
    bad.push(`左缘那条收起没贴住面板（它的右边 ${e1.edge.right} ≠ 面板左边 ${e1.panelX}）`);
  }
  if (!e1.vertical) bad.push("左缘那条收起没有竖直居中");
  // 改窄窗口 → 还贴不贴（"没有跟着侧边栏动"就是这条的反面）
  await page.evaluate(() => window.resizeTo(1100, 820));
  await sleep(700);
  const e2 = await edgeState();
  if (!e2.edge || Math.abs(e2.edge.right - e2.panelX) > 2) {
    bad.push(`窗口改窄之后那条收起没跟着面板走（${JSON.stringify(e2)}）`);
  }
  await page.evaluate(() => window.resizeTo(1440, 900));
  await sleep(700);
  note(`摘要左缘「收起」：在 ✓ / 带字「${e1.text}」/ 贴边 ${e1.edge.right}≈${e1.panelX} / 改窄后仍贴 ✓`);
}

// 往返 10 次
let aRound = 0;
for (let i = 0; i < 10; i += 1) {
  await openSummary(page);
  if ((await summaryState()).collapsed) break;
  await page.locator('[data-testid="wb-summary-collapse"]').click();
  await sleep(200);
  if (!(await summaryState()).collapsed) break;
  aRound += 1;
}
if (aRound !== 10) bad.push(`摘要面板反复开合只有 ${aRound}/10 次一致`);
note(`摘要面板：默认收起 ✓ / 带字收起入口「${a1.collapseText}」/ 往返 ${aRound}/10`);

// Esc 收起
await openSummary(page);
await page.keyboard.press("Escape");
await sleep(350);
if (!(await summaryState()).collapsed) bad.push("摘要面板按 Esc 没有收起");
note(`摘要面板 Esc：${(await summaryState()).collapsed ? "✓ 收起了" : "✗ 没反应"}`);

/* ---------- 面板 B：画布对话侧栏 ---------- */

if (!(await openCanvas(page))) bad.push("画布打不开 —— 下面的侧栏断言无从谈起");
await sleep(1200);

const sideState = () =>
  page.evaluate(() => {
    const toggle = document.querySelector('[data-testid="wb-canvas-chat-toggle"]');
    const side = document.querySelector(".wb-canvas .side.left");
    const head = document.querySelector('[data-testid="wb-chat-collapse"]');
    if (!toggle) return { toggle: false };
    const r = toggle.getBoundingClientRect();
    const at = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return {
      toggle: true,
      open: Boolean(side),
      hitIsToggle: at === toggle || Boolean(at?.closest?.('[data-testid="wb-canvas-chat-toggle"]')),
      headCollapse: Boolean(head),
      headText: (head?.textContent ?? "").trim(),
    };
  });

const b0 = await sideState();
if (!b0.toggle) bad.push("找不到画布对话侧栏的开关把手");
if (b0.open) bad.push("画布对话侧栏默认应当收起");
if (!b0.hitIsToggle) bad.push("把手中心被别的东西挡住了（热区被吞）—— 点了会没反应");

await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
await sleep(800);
const b1 = await sideState();
if (!b1.open) bad.push("点把手后画布对话侧栏没有展开");
if (!b1.headCollapse) bad.push("画布对话侧栏展开后，头上没有「收起」入口（关的入口只剩一颗 17px 的把手）");
if (!/收起/.test(b1.headText)) bad.push(`画布对话侧栏的收起入口不带字（实测=「${b1.headText}」）`);
note(`画布侧栏：把手热区${b0.hitIsToggle ? "未被吞 ✓" : "被吞 ✗"} / 头上收起入口「${b1.headText}」`);

// 用头上那颗「收起」关一次（这才是工单要的入口）
if (b1.headCollapse) {
  await page.locator('[data-testid="wb-chat-collapse"]').click();
  await sleep(600);
  if ((await sideState()).open) bad.push("点头上的「收起」没有关掉画布对话侧栏");
  note(`用头上「收起」关闭：${(await sideState()).open ? "✗ 没关掉" : "✓ 关掉了"}`);
}

// 往返 10 次（用把手，它是唯一的开入口）
let bRound = 0;
for (let i = 0; i < 10; i += 1) {
  const t = page.locator('[data-testid="wb-canvas-chat-toggle"]');
  await t.click();
  await sleep(320);
  const opened = (await sideState()).open;
  await t.click();
  await sleep(320);
  const closed = (await sideState()).open;
  if (!opened || closed) break;
  bRound += 1;
}
if (bRound !== 10) bad.push(`画布对话侧栏反复开合只有 ${bRound}/10 次一致`);
note(`画布侧栏往返：${bRound}/10`);

// Esc 关闭
await page.locator('[data-testid="wb-canvas-chat-toggle"]').click();
await sleep(600);
await page.keyboard.press("Escape");
await sleep(400);
const bEsc = await sideState();
if (bEsc.open) bad.push("画布对话侧栏按 Esc 没有收起");
note(`画布侧栏 Esc：${bEsc.open ? "✗ 没反应" : "✓ 收起了"}`);

/* ---------- Esc 的边界：在输入框里打字时不许收面板 ---------- */

if (await openSummary(page)) {
  const input = page.locator('[data-testid="wb-summary"] input, [data-testid="wb-summary"] textarea').first();
  if ((await input.count()) > 0) {
    await input.click();
    await page.keyboard.press("Escape");
    await sleep(300);
    if ((await summaryState()).collapsed) {
      bad.push("焦点在输入框里时 Esc 把面板收掉了 —— 正在写的草稿会丢");
    } else {
      note("Esc 边界：焦点在输入框里时不收面板 ✓");
    }
  } else {
    note("（摘要面板里没有输入框，Esc 那条边界改由源码守卫覆盖）");
  }
  await page.keyboard.press("Escape");
  await sleep(300);
}

console.log("");
if (bad.length) {
  console.error("✗ " + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 右侧面板：两个都能开能关、收起入口都带字、Esc 可关、往返各 10 次一致、把手热区未被吞");
}

await browser.close();
await killLeftovers();
