import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { shot } from "./harness.mjs";

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

const EXE = "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe";
const child = spawn(EXE, [".", "--remote-debugging-port=9511"], {
  cwd: "D:/DoubaoWorkClone",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9511");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
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

const child2 = spawn(EXE, [".", "--remote-debugging-port=9512"], {
  cwd: "D:/DoubaoWorkClone",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});
await new Promise((r) => setTimeout(r, 8000));
const browser2 = await chromium.connectOverCDP("http://127.0.0.1:9512");
const page2 = (browser2.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"))) ?? browser2.contexts()[0].pages()[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);

await page2.waitForSelector(".react-flow__node", { state: "attached" });
await page2.waitForTimeout(2500);
report.afterRestart = {
  htmlNodes: await page2.locator(".react-flow__node-html").count(),
  frames: await page2.locator("iframe.nv-html-frame").count(),
};
await browser2.close();
child2.kill();

console.log(JSON.stringify(report, null, 2));
