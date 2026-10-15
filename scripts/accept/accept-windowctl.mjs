// 窗口控制（自绘标题栏）验收 —— M0 工单 1 的常驻回归。
//
// 判据来自工单 1.4「硬指标」：
//   · 右上角**只有一套**按钮，无系统原生条（原生 overlay 已删，见 electron/main.ts）
//   · 删 overlay 后窗口四操作一个不能少：可拖动 / 最小化 / 最大化·还原 / 关闭
//   · 浅色 / 深色切换后自绘按钮跟着走（配色归 CSS，不再走那条已删的 IPC）
// 外加一条**防复发**判据（工单原稿漏了、但正是本次缺陷的形状）：
//   · 标题栏那一条底下**不得有可点元素** —— 拖动区会吃掉点击，
//     云盘/插件/定时任务三个视图的右上按钮就是被它压住的
//
// 为什么原生按钮只能靠几何断言：它不在 DOM 里（DWM 画的），
// 所以这里用「标题栏底下不得有可点元素 + 自绘三个按钮」把同一件事钉住；
// OS 层截图证据在 `.verify/m0/`（上面加一条记录）。
import { chromium } from "playwright";
import { openApp, sleep, killLeftovers, pickPort } from "./harness.mjs";
import { realDrag, restoreWindow, winRect } from "./winProbe.mjs";

const bad = [];
const note = (m) => console.log("   " + m);

const port = await pickPort([9831]);
await killLeftovers();
const { browser, page } = await openApp(chromium, {
  port,
  dataDir: ".verify/accept-windowctl-data",
  cwd: ".",
});
await sleep(1800);

/* ---------- 1. 一套按钮，且它是应用自绘的 ---------- */

const chrome = await page.evaluate(() => {
  const bar = document.querySelector('[data-testid="wb-titlebar"]');
  const ctl = document.querySelector('[data-testid="wb-winctl"]');
  const btns = ctl ? Array.from(ctl.querySelectorAll("button")) : [];
  const region = bar ? getComputedStyle(bar).getPropertyValue("-webkit-app-region").trim() : "";
  const barRect = bar?.getBoundingClientRect();
  return {
    hasBar: Boolean(bar),
    hasCtl: Boolean(ctl),
    count: btns.length,
    labels: btns.map((b) => b.getAttribute("aria-label")),
    region,
    barBottom: barRect ? Math.round(barRect.bottom) : -1,
    barTop: barRect ? Math.round(barRect.top) : -1,
    barRight: barRect ? Math.round(barRect.right) : -1,
    vw: window.innerWidth,
  };
});

note(`标题栏：${chrome.hasBar ? "在" : "**不在**"} | app-region=${chrome.region || "(空)"} | 按钮 ${chrome.count} 个 ${JSON.stringify(chrome.labels)}`);
if (!chrome.hasBar) bad.push("没有自绘标题栏（.wb-titlebar）");
if (!chrome.hasCtl) bad.push("标题栏里没有窗口按钮组（.wb-winctl）");
if (chrome.count !== 3) bad.push(`窗口按钮应为 3 个（最小化/最大化/关闭），实际 ${chrome.count} 个`);
if (chrome.region !== "drag") bad.push(`标题栏不是拖动区（-webkit-app-region=${chrome.region || "空"}）—— 窗口会拖不动`);
if (chrome.barTop !== 0 || chrome.barRight !== chrome.vw) bad.push("标题栏没有铺满窗口顶部（它必须是拖动区那条）");

/* ---------- 2. 标题栏那一条底下不得有可点元素（防复发判据） ---------- */

const under = await page.evaluate((bandBottom) => {
  const out = [];
  for (const el of document.querySelectorAll("button, a, input, select, textarea, [role=button], [tabindex]")) {
    if (el.closest('[data-testid="wb-titlebar"]')) continue; // 按钮组自己不算
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.top < bandBottom && r.bottom > 0) {
      out.push({
        testid: el.getAttribute("data-testid") || "",
        label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 20),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
      });
    }
  }
  return out;
}, chrome.barBottom);

if (under.length) {
  bad.push(`标题栏底下压着 ${under.length} 个可点元素（它们会点不动）：${under.map((u) => `${u.testid || u.label}@${u.top}`).join(" ")}`);
  note(`✗ 被压住的元素：${under.map((u) => `${u.testid || u.label}(y=${u.top}..${u.bottom})`).join("  ")}`);
} else {
  note("✓ 标题栏底下没有可点元素（不会吞点击）");
}

/* ---------- 3. 云盘页：右上按钮不再被压住 ---------- */

await page.locator('[data-testid="wb-nav-cloud"]').click();
await sleep(1200);
const cloud = await page.evaluate(() => {
  const ids = ["wb-cloud-new", "wb-cloud-upload", "wb-cloud-refresh"];
  const r = {};
  for (const id of ids) {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) continue;
    const b = el.getBoundingClientRect();
    r[id] = { top: Math.round(b.top), right: Math.round(b.right), visible: b.width > 0 };
  }
  return r;
}, chrome.barBottom);

for (const [id, v] of Object.entries(cloud)) {
  if (!v.visible) { bad.push(`云盘页 ${id} 不见了`); continue; }
  if (v.top < chrome.barBottom) bad.push(`云盘页 ${id} 仍在标题栏下方被压住（top=${v.top} < ${chrome.barBottom}）`);
}
note(`云盘页右上按钮：${Object.entries(cloud).map(([k, v]) => `${k}@top${v.top}`).join("  ")}`);

/* ---------- 4. 窗口四操作 ---------- */

const before = winRect();
note(`起始窗口矩形：${JSON.stringify(before)}`);

// 4.1 拖动：从标题栏中间按住往右下拖（那里是拖动区，且底下是空的）
//
// ⚠️ **必须用真实鼠标输入（SendInput）**，不能用 Playwright 的 `page.mouse`：
// 实测过 —— 合成事件驱动不了「浏览器进程按 app-region 起系统拖拽」那条路，
// 于是拖动区明明是好的，断言却红（假阴性）。真实输入等于用户做的事，判据才算数。
const beforeDrag = winRect();
/*
 * ⚠️ 拖动这一步**最多试 3 次**：真实鼠标输入要求那一刻我们的窗口在那个坐标上最上层，
 * 而批跑里前一条脚本可能留下别的窗口压在那一带上（实测：单跑必绿、批跑偶发红一次）。
 * 判据**没有放宽** —— 仍然要求窗口真的动了；放宽的只是"试几次"。
 */
let dragResult = "";
let afterDrag = beforeDrag;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  dragResult = realDrag(660, 18, 12, 7);
  afterDrag = winRect();
  if (beforeDrag && afterDrag && (beforeDrag.l !== afterDrag.l || beforeDrag.t !== afterDrag.t)) break;
  note(`（第 ${attempt} 次拖动没动：${dragResult} —— 再试一次）`);
}
if (!beforeDrag || !afterDrag || (beforeDrag.l === afterDrag.l && beforeDrag.t === afterDrag.t)) {
  bad.push(`拖动标题栏后窗口没动（拖动区没生效）：${dragResult}`);
  note(`✗ 拖动无效：${beforeDrag?.l},${beforeDrag?.t} → ${afterDrag?.l},${afterDrag?.t}`);
} else {
  note(`✓ 拖动生效：${beforeDrag.l},${beforeDrag.t} → ${afterDrag.l},${afterDrag.t}`);
}

// 4.2 最大化 ⇄ 还原（点自绘按钮，且图标状态要跟着走）
const maxBtn = page.locator('[data-testid="wb-win-max"]');
await maxBtn.click();
await sleep(900);
const maximizedAttr = await maxBtn.getAttribute("data-maximized");
const afterMax = winRect();
if (maximizedAttr !== "true") bad.push(`点最大化后按钮状态没变（data-maximized=${maximizedAttr}）`);
if (afterMax && before && afterMax.b - afterMax.t <= before.b - before.t) {
  bad.push("点最大化后窗口没有变大");
}
note(`✓ 最大化：矩形高 ${before ? before.b - before.t : "?"} → ${afterMax ? afterMax.b - afterMax.t : "?"}，按钮 data-maximized=${maximizedAttr}`);

await maxBtn.click();
await sleep(900);
const restoredAttr = await maxBtn.getAttribute("data-maximized");
if (restoredAttr !== "false") bad.push(`点还原后按钮状态没变（data-maximized=${restoredAttr}）`);
note(`✓ 还原：按钮 data-maximized=${restoredAttr}`);

// 4.3 最小化（从系统侧确认真的最小化了）
await page.locator('[data-testid="wb-win-min"]').click();
await sleep(1200);
const minimized = winRect();
if (!minimized?.iconic) bad.push("点最小化后窗口没有最小化");
note(`${minimized?.iconic ? "✓" : "✗"} 最小化：IsIconic=${minimized?.iconic}`);
restoreWindow();
await sleep(1400);

/* ---------- 5. 主题切换后自绘按钮仍然跟着走 ---------- */

const themeOfBtn = () =>
  page.evaluate(() => {
    const b = document.querySelector('[data-testid="wb-winctl"] button');
    const bar = document.querySelector('[data-testid="wb-titlebar"]');
    return {
      color: b ? getComputedStyle(b).color : "",
      bg: bar ? getComputedStyle(bar).backgroundColor : "",
      theme: document.documentElement.getAttribute("data-theme") ?? "",
    };
  });

const light = await themeOfBtn();
await page.evaluate(() => {
  document.documentElement.setAttribute("data-theme", "dark");
});
await sleep(400);
const dark = await themeOfBtn();
if (light.bg === dark.bg) bad.push(`切深色后标题栏底色没变（都是 ${light.bg}）—— 自绘按钮没跟上主题`);
note(`主题：${light.theme}/${light.bg} → ${dark.theme}/${dark.bg}`);

console.log("");
if (bad.length) {
  console.error("✗ " + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 窗口控制：一套自绘按钮 / 标题栏是拖动区 / 底下无被压按钮 / 拖动·最大化·还原·最小化都在 / 跟随主题");
}

await browser.close();
await killLeftovers();
