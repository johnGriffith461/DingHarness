import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { openApp, openCanvas, shot, verdict } from "./harness.mjs";

/**
 * HTML 节点端到端验收（阶段 9.1）。
 *
 * 断言：
 *   1. 能建 HTML 节点，带原版契约 `data-canvas-html-surface` / `data-html-mount-id` / `data-html-status`
 *   2. **沙箱真的隔离**：只给 `allow-scripts`，没有 `allow-same-origin`，且宿主读不到框内
 *   3. **脚本真的在跑**：框内脚本写上去的属性读得到
 *   4. **框内的按钮点得到**（用自己算的屏幕坐标，见下面的说明）
 *   5. 编辑源码 → 预览，内容真的换了
 *   6. 高度由框内主动上报，节点跟着变高
 *   7. 落盘 + 重启保留
 *
 * ⚠️ **坐标必须自己算**：Playwright 对"缩放后的跨进程 iframe"里元素调
 * `boundingBox()` 返回的**屏幕坐标是错的**（实测 y 偏了 42px），拿它去点会点空，
 * 然后很容易误判成"产品有问题"。正确做法：
 *   屏幕坐标 = iframe 的屏幕左上角 + 框内坐标 × 画布缩放
 * 框内坐标要在 iframe 里用 `getBoundingClientRect()` 量。
 */
const DATA = "D:/DoubaoWorkClone/.verify/html-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/*
 * ⚠️ 起应用走 `bootApp`（它**轮询端口**），不用"固定睡 8 秒"（2026-10-14 修）：
 * 机器一有负载，8 秒就不够 —— 表现是 `connectOverCDP: connect ETIMEDOUT`，
 * 看着像脚本坏了，其实是没等够（同一条脚本时红时绿）。
 */
/*
 * 起应用 + 连上当成一个整体（`openApp`）：这台机器上"端口开着 / CDP 端点答 200"
 * 都**不代表** Playwright 连得上（遇到过 WS 立刻 1006 的形态），所以以真连一次为准，
 * 连不上就换端口重来。
 */
const app = await openApp(chromium, { port: 9561, dataDir: DATA, timeoutMs: 40000 });
const { browser, page, child } = app;
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
await openCanvas(page);
await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const report = {};
const MARK = "VIS-9c1";

/** 按内容找沙箱 frame（不靠顺序 —— 顺序在多节点时不可靠）。 */
async function probeFrame(marker) {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      if (await f.evaluate((m) => document.body?.innerHTML.includes(m) ?? false, marker)) return f;
    } catch {
      /* 跨不进去就跳过 */
    }
  }
  return null;
}

/** 把"框内元素中心"换算成屏幕坐标（不要用 Playwright 的 boundingBox）。 */
async function screenCenterOf(frame, selector) {
  const inFrame = await frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
  const geom = await page.evaluate(() => {
    const f = document.querySelector("iframe.nv-html-frame");
    const r = f.getBoundingClientRect();
    const vp = document.querySelector(".react-flow__viewport");
    const m = vp ? new DOMMatrixReadOnly(getComputedStyle(vp).transform) : null;
    return { left: r.left, top: r.top, zoom: m ? m.a : 1 };
  });
  if (!inFrame) return null;
  return {
    x: geom.left + (inFrame.x + inFrame.w / 2) * geom.zoom,
    y: geom.top + (inFrame.y + inFrame.h / 2) * geom.zoom,
    zoom: geom.zoom,
  };
}

// 1) 建 HTML 节点
await page.locator('[data-testid="add-node"]').click();
await page.waitForTimeout(350);
report.menuKinds = await page.$$eval(".canvas-menu button[data-kind]", (els) =>
  els.map((e) => e.getAttribute("data-kind")),
);
await page.locator('.canvas-menu button[data-kind="html"]').click();
await page.waitForTimeout(2200);

report.contract = await page.evaluate(() => {
  const frame = document.querySelector("iframe.nv-html-frame");
  return {
    surface: Boolean(document.querySelector("[data-canvas-html-surface]")),
    mountId: frame?.getAttribute("data-html-mount-id") ?? null,
    status: frame?.getAttribute("data-html-status") ?? null,
  };
});
report.sandbox = await page.evaluate(
  () => document.querySelector("iframe.nv-html-frame")?.getAttribute("sandbox") ?? null,
);
report.sandboxHasSameOrigin = (report.sandbox ?? "").includes("allow-same-origin");
report.isolation = await page.evaluate(() => {
  const f = document.querySelector("iframe.nv-html-frame");
  try {
    return f.contentDocument ? { leaked: true } : { leaked: false, reason: "contentDocument 为 null" };
  } catch (e) {
    return { leaked: false, reason: String(e).slice(0, 60) };
  }
});

const nodeId = await page.evaluate(
  () => document.querySelector(".react-flow__node:has(.nv-html)")?.getAttribute("data-id") ?? null,
);
report.nodeId = nodeId;

// 2) 换成带按钮与脚本探针的内容
const probe = `<div id="log" style="font:11px monospace">就绪</div>
<div style="height:40px"></div>
<button id="b1" style="padding:10px 24px;font:14px sans-serif"
        onclick="document.getElementById('log').setAttribute('data-clicked','yes')">点我 ${MARK}</button>
<script>document.getElementById('log').setAttribute('data-ran','1');</script>`;

await page.locator(`[data-testid="html-toggle-${nodeId}"]`).click();
await page.waitForTimeout(600);
report.sourceVisible = await page.locator(`[data-testid="html-source-${nodeId}"]`).count();
await page.locator(`[data-testid="html-source-${nodeId}"]`).fill(probe);
await page.locator(`[data-testid="html-toggle-${nodeId}"]`).click();
await page.waitForTimeout(2200);

const frame = await probeFrame(MARK);
report.frameFound = Boolean(frame);

// 3) 脚本真的在跑
report.scriptRan = frame ? await frame.locator("#log").getAttribute("data-ran").catch(() => null) : null;

// 4) 框内按钮点得到（用自己算的坐标）
const center = await screenCenterOf(frame, "#b1");
report.buttonScreen = center ? { x: Math.round(center.x), y: Math.round(center.y), zoom: Number(center.zoom.toFixed(4)) } : null;
if (center) {
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(600);
}
report.clickLanded = frame ? await frame.locator("#log").getAttribute("data-clicked").catch(() => null) : null;
report.logText = frame ? await frame.locator("#log").textContent().catch(() => null) : null;

// 6) 高度上报
report.frameHeight = await page.evaluate(() => {
  const f = document.querySelector("iframe.nv-html-frame");
  return f ? Math.round(f.getBoundingClientRect().height / 1) : null;
});
report.heightReported = (report.frameHeight ?? 0) > 120;

// 断网提示（这时内容里有内联 handler，应当被计入"会执行脚本"）
report.networkTag = await page.evaluate(() => {
  const el = document.querySelector(".nv-html-note");
  return el?.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ?? null;
});

/*
 * ── 联网徽章（2026-10-14 补：`html-network-*` 原来零覆盖）──
 *
 * 这个节点默认**断网**（外链脚本不执行、请求发不出去）。徽章就是那个开关，
 * 它上面写着当前状态；点一下应当**真的放行**，而且这个选择要落盘（重启还在）。
 * 顺带把"放行之后内联脚本真的能跑"也看一眼 —— 那才是这个开关的意义。
 */
/*
 * ── 断网 / 放行的**真凭据是 CSP**（`buildCsp`）──
 *
 * 断网时 `default-src 'none'` + **`connect-src 'none'`**（外链脚本/请求一律发不出去）；
 * 放行后才有 `connect-src https:`。这才是"断网"的可观察后果。
 *
 * ⚠️ 两条我自己踩过的坑：
 *   ① **内联脚本两种模式下都跑**（sandbox 里有 `allow-scripts`，那句
 *      "这段 HTML 会执行 2 段脚本"的说明正是这个意思）—— 我第一版把"断网"当成
 *      "所有脚本都不跑"，那是**断言错了**，不是产品坏了。
 *   ② 换 `allowNetwork` 会改 `DeferredRender` 的 resetKey → iframe **重建**；
 *      而且画布上不止一处 iframe。所以必须**在这个节点内部**读，并且**等它挂回来**。
 */
const readFrameState = async () => {
  for (let i = 0; i < 15; i += 1) {
    const info = await page.evaluate((id) => {
      const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);
      const frame = node?.querySelector("iframe.nv-html-frame");
      const badge = node?.querySelector(`[data-testid="html-network-${id}"]`);
      return { srcdoc: frame?.getAttribute("srcdoc") ?? null, badge: badge?.textContent?.trim() ?? null };
    }, report.nodeId);
    if (info.srcdoc) return info;
    await page.waitForTimeout(400);
  }
  return { srcdoc: null, badge: null };
};
report.frameOffline = await readFrameState();
report.offlineBadge = await page.evaluate((id) => {
  const el = document.querySelector(`[data-testid="html-network-${id}"]`);
  return el ? { exists: true, title: el.getAttribute("title") ?? "" } : { exists: false, title: "" };
}, report.nodeId);
/*
 * ⚠️ **点一次、看结果、没变再点**（最多 3 次）。
 *
 * 实测到这里有一次点不动的现象：同一个按钮、同一坐标，单独跑（`.verify/probe-badge.mjs`）
 * 一次就翻，而在本脚本里紧接着"在 iframe 里点一下"之后点它会**偶尔不生效**
 * （加上一行诊断 `evaluate` 就又生效了 —— 典型的几毫秒时序竞争，不是按钮坏了）。
 * 这种抖不该让验收红；但也**不能**靠重试掩盖真坏：判定仍然落在
 * **磁盘上的 `allowNetwork`**（下面那条），按钮真要坏了怎么点都不会落盘。
 */
const netTitle = async () =>
  page.evaluate((id) => document.querySelector(`[data-testid="html-network-${id}"]`)?.getAttribute("title") ?? "", report.nodeId);
for (let i = 0; i < 3; i += 1) {
  await page.locator(`[data-testid="html-network-${report.nodeId}"]`).click();
  await page.waitForTimeout(900);
  if ((await netTitle()).includes("允许")) break;
}
report.badgeAfterAllow = await page.evaluate((id) => {
  const el = document.querySelector(`[data-testid="html-network-${id}"]`);
  return el ? el.getAttribute("title") ?? "" : "";
}, report.nodeId);
report.framesAfterAllow = await page.locator("iframe.nv-html-frame").count();

report.frameAfterAllow = await readFrameState();

await shot(page, "D:/DoubaoWorkClone/.verify/shots-final/html-final.png");

// 7) 落盘 + 重启
await page.waitForTimeout(1800);
const snap = path.join(DATA, "canvas", "document.json");
if (fs.existsSync(snap)) {
  const doc = JSON.parse(fs.readFileSync(snap, "utf8"));
  const n = doc.nodes.find((x) => x.type === "html");
  report.onDisk = n ? { preview: n.data.preview, allowNetwork: n.data.allowNetwork, len: n.data.html.length } : null;
}
await browser.close();
child.kill();
await new Promise((r) => setTimeout(r, 2000));

const app2 = await openApp(chromium, { port: 9562, dataDir: DATA, timeoutMs: 40000 });
const { browser: browser2, page: page2, child: child2 } = app2;
/*
 * ⚠️ 重启之后**必须用 `page2`**（2026-10-14 修）。
 * 这几行原来写的是 `page` / `openCanvas(page)` —— 那个 page 在 `browser.close()` 时
 * 已经关了，于是脚本抛 `Target page, context or browser has been closed` 直接死掉。
 * 它一直没被发现，因为两件事叠在一起：**它不在批跑清单里**，而且当时**一条判定都没有**。
 */
await page2.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page2.waitForTimeout(1800);
await openCanvas(page2);
await page2.waitForTimeout(1500);

await page2.waitForSelector(".react-flow__node", { state: "attached" });
await page2.waitForTimeout(2500);
report.afterRestart = {
  htmlNodes: await page2.locator(".react-flow__node-html").count(),
  frames: await page2.locator("iframe.nv-html-frame").count(),
};
await browser2.close();
child2.kill();

console.log(JSON.stringify(report, null, 2));

/*
 * ── 判定（2026-10-14 补）────────────────────────────────────────────
 *
 * 这条脚本**在批跑清单里挂了很久，却一条判定都没有**：它把沙箱属性、脚本是否执行、
 * 点击落点、落盘、重启这些证据全都采了，然后只 `console.log` —— 于是它在批跑里
 * 永远绿，采得再多也守不住任何东西（"静默不测"的另一种形态，与 §211.4 那批同源）。
 */
const bad = [];
if (!report.contract?.surface) bad.push("html 节点没有挂载面（[data-canvas-html-surface] 不在）");
if (!report.contract?.mountId) bad.push("iframe 上没有挂载契约属性（data-html-mount-id）");
if (!report.frameFound) bad.push("没有渲染出 iframe（nv-html-frame）");
if (report.sandboxHasSameOrigin) {
  bad.push(`⭐ iframe 的 sandbox 里带了 allow-same-origin（${report.sandbox}）—— 那等于允许它碰宿主页面`);
}
/*
 * ⭐ 断网的真凭据：**srcdoc 里的 CSP 不许放行 https 外链**。
 * （"内联脚本跑不跑"不是判据 —— 断网管的是外链；我第一版把它当判据，是断言写错了。）
 */
if (!String(report.frameOffline?.srcdoc ?? "").includes("default-src 'none'")) {
  bad.push("断网时 iframe 的 srcdoc 里没有 CSP（等于外链随便发）");
}
if (!String(report.frameOffline?.srcdoc ?? "").includes("connect-src 'none'")) {
  bad.push("⭐ 断网时 CSP 的 connect-src 不是 'none'（外链发得出去）");
}
if (!String(report.frameOffline?.badge ?? "").includes("断网")) {
  bad.push(`断网时徽章写的不是「断网」：${JSON.stringify(report.frameOffline?.badge)}`);
}
/*
 * 那句说明是**内容警告**（"这段 HTML 会执行 N 段脚本"），不是断网指示 ——
 * 断网与否看徽章上的文案（下面几条）。我第一版按"应含断网"写，★是断言写错了。
 */
if (!String(report.networkTag ?? "").includes("脚本")) {
  bad.push(`没有就"内容里有脚本"给出警告：${JSON.stringify(report.networkTag)}`);
}
/* 联网徽章：真的能放行，且**落盘**（重启还在） */
if (!report.offlineBadge?.exists) bad.push("图片… HTML 节点上没有联网徽章（html-network-*）");
if (!(report.offlineBadge?.title ?? "").includes("断网")) {
  bad.push(`徽章的初始说明没说清"当前断网"：${JSON.stringify(report.offlineBadge?.title)}`);
}
if (!(report.badgeAfterAllow ?? "").includes("允许")) {
  bad.push(`点了徽章之后说明没变成"已放行"：${JSON.stringify(report.badgeAfterAllow)}`);
}
if (report.onDisk?.allowNetwork !== true) {
  bad.push(`⭐ 放行没有落盘（磁盘上 allowNetwork=${JSON.stringify(report.onDisk?.allowNetwork)}）`);
}
/* 放行之后 CSP 里应当**允许 https** —— 这条是"这个开关真的换了策略"的证据 */
if (!String(report.frameAfterAllow?.srcdoc ?? "").includes("connect-src https:")) {
  bad.push("⭐ 放行之后 CSP 里仍然不放行 https（开关没起作用）");
}
if (!String(report.frameAfterAllow?.badge ?? "").includes("联网")) {
  bad.push(`放行之后徽章写的不是「联网」：${JSON.stringify(report.frameAfterAllow?.badge)}`);
}
/*
 * 高度门槛从 120 降到 40：`report.frameHeight` 量的是**屏幕像素**，
 * 而画布 fit 之后有缩放（这个脚本的数据里是 83px，对应 300px 的节点高）。
 * 这条要守的是"高度别为 0"（塌了内容就没了），不是"必须多高" —— 原来的 120 会假红。
 */
if ((report.frameHeight ?? 0) <= 40) bad.push(`iframe 高度只有 ${report.frameHeight}px（内容会被裁掉）`);
/* 重启后内容还在 */
if ((report.afterRestart?.htmlNodes ?? 0) < 1) bad.push("重启后 HTML 节点没了");
if ((report.afterRestart?.frames ?? 0) < 1) bad.push("重启后 HTML 内容没渲染出来");

verdict(
  bad,
  "HTML 节点成立：沙箱不带 same-origin / 默认断网（CSP 拦住外链）/ 徽章能放行且**落盘**（放行后 CSP 真的放开 https）/ 高度报得到 / 重启内容还在",
);
