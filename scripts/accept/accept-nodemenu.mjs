import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, pickPort, shot, waitForPort, dismissFirstRunIfShown } from "./harness.mjs";

/**
 * 11.28 验收：画布节点右键菜单。
 *
 * ## 写法上的一个决定：**每条断言都从干净状态开始**
 * 上一版把动作串成一条流水线，结果互相污染：复制出来的副本盖住原件、
 * 隐藏把目标从 DOM 里拿掉、拖动又改了位置……每修一处又冒出下一处。
 * 现在每个断言前 `reload()` 重置画布，互不影响。慢一点，但**结论可靠**。
 *
 * ## 不用 store 调试出口
 * `window.__canvasStore` 是 DEV-only，构建版没有。所以全部走**行为级**断言：
 * 拖不拖得动、DOM 少没少、菜单项是否被禁用 —— 这比读内部状态更有说服力。
 */
const DATA = ".verify/nm2";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12700]);
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
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await dismissFirstRunIfShown(page);
await page.waitForTimeout(1500);

const report = {};
const shots = ".verify/shots-final";
const countNodes = () => page.locator(".react-flow__node").count();

/** 重置到干净画布：重载 + 打开画布。 */
const reset = async () => {
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await dismissFirstRunIfShown(page);
  await page.waitForTimeout(1200);
  const open = await page.locator('[data-testid="wb-canvas"]').count();
  if (open === 0) {
    await openCanvas(page);
    await page.waitForTimeout(2200);
  }
};

/**
 * 找一个"上有未被遮挡落点"的节点并右键。
 *
 * 不写死序号：初始文档里的节点本来就互相重叠，写死会随布局失效。
 * 也不用 `locator.click()` —— 它做遮挡检查会直接报错，
 * 而用户右键是不做这种检查的。
 */
const openMenu = async () => {
  const spot = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll(".react-flow__node"));
    const rects = all.map((el) => el.getBoundingClientRect());
    // 优先点**当前选中的**那个：操作完会保持选中，连续操作才落在同一个节点上
    const selected = all.findIndex((el) => el.classList.contains("selected"));
    const order =
      selected >= 0
        ? [selected, ...rects.map((_, i) => i).filter((i) => i !== selected)]
        : rects.map((_, i) => i);
    for (const i of order) {
      const r = rects[i];
      for (let dy = 6; dy < r.height - 6; dy += 6) {
        for (let dx = 6; dx < r.width - 6; dx += 6) {
          const x = r.x + dx;
          const y = r.y + dy;
          if (rects.some((o, j) => j !== i && x >= o.x && x <= o.right && y >= o.y && y <= o.bottom)) continue;
          return { index: i, x: Math.round(x), y: Math.round(y) };
        }
      }
    }
    return null;
  });
  if (!spot) throw new Error("找不到可点的位置");
  await page.mouse.click(spot.x, spot.y, { button: "right" });
  await page.waitForTimeout(600);
  return spot;
};

const pick = async (label) => {
  await page.locator(`[data-testid="cv-ctx-${label}"]`).click();
  await page.waitForTimeout(1000);
};

/**
 * 确保目标处于锁定状态。
 *
 * ⚠️ 这里有个容易搞错的地方：**画布把 `locked` 持久化了**，`reload()` 恢复的是
 * 同一份文档 —— 上一条断言锁上的节点，重载后仍然是锁着的（这是**正确行为**）。
 * 所以不能假设重置后一定是"未锁定"，要看菜单当前显示的是哪一项。
 */
const ensureLocked = async () => {
  await openMenu();
  if ((await page.locator('[data-testid="cv-ctx-锁定"]').count()) > 0) {
    await pick("锁定");
  } else {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
};

try {
  await reset();
  report.nodesAtStart = await countNodes();

  /* ---------- 菜单本身 ---------- */
  await openMenu();
  report.menuOpened = await page.locator('[data-testid="cv-node-menu"]').count();
  /*
   * ⚠️ 2026-10-14：读菜单项之前**先确认菜单真的开着**。
   * 这条脚本以前**没有判定**，所以"读到一份空菜单"也照样 exit 0 —— 加上判定之后才暴露：
   * 实测读到 0 项（菜单在读取那一刻已经关了/还没开），于是「菜单里少了复制/删除/…」全红。
   * 那是**脚本的读法**有问题（不是产品没这些项）。这里等到菜单容器真出现，再等一拍让项渲染完。
   */
  await page.locator('[data-testid="cv-node-menu"]').first().waitFor({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(250);
  report.menuItems = await page.$$eval('[data-testid^="cv-ctx-"]', (els) =>
    els.map((e) => ({ t: e.textContent.trim(), off: e.disabled })),
  );
  await shot(page, path.join(shots, "wb-25-nodemenu.png"));

  /* ---------- 复制 ---------- */
  await reset();
  const base = await countNodes();
  await openMenu();
  await pick("复制");
  report.copyDelta = (await countNodes()) - base;

  /* ---------- 锁定：真的拖不动 ---------- */
  await reset();
  await ensureLocked();
  const spot = { x: 0, y: 0 };
  const rect = await page.locator(".react-flow__node").first().boundingBox();
  spot.x = Math.round(rect.x + rect.width / 2);
  spot.y = Math.round(rect.y + 10);
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.down();
  await page.mouse.move(spot.x + 100, spot.y + 90, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const rect2 = await page.locator(".react-flow__node").first().boundingBox();
  report.lockedDrag = { dx: Math.round(rect2.x - rect.x), dy: Math.round(rect2.y - rect.y) };
  report.lockedDidNotMove = Math.abs(rect2.x - rect.x) < 3 && Math.abs(rect2.y - rect.y) < 3;

  /* ---------- 解锁后能拖 ---------- */
  await reset();
  await ensureLocked();
  await openMenu();
  report.menuHasUnlock = await page.locator('[data-testid="cv-ctx-解锁"]').count();
  await pick("解锁");
  const b3 = await page.locator(".react-flow__node").first().boundingBox();
  await page.mouse.move(Math.round(b3.x + b3.width / 2), Math.round(b3.y + 10));
  await page.mouse.down();
  await page.mouse.move(Math.round(b3.x + b3.width / 2 + 100), Math.round(b3.y + 100), { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const b4 = await page.locator(".react-flow__node").first().boundingBox();
  report.unlockedMoved = Math.abs(b4.x - b3.x) > 10 || Math.abs(b4.y - b3.y) > 10;

  /* ---------- 层级 ---------- */
  await reset();
  const orderBefore = await page.$$eval(".react-flow__node", (els) => els.map((e) => e.getAttribute("data-id")));
  await openMenu();
  await pick("移到最前");
  const orderAfter = await page.$$eval(".react-flow__node", (els) => els.map((e) => e.getAttribute("data-id")));
  report.orderChanged = orderBefore.join() !== orderAfter.join();
  report.movedToEnd = orderAfter[orderAfter.length - 1] === orderBefore[0];

  /* ---------- 隐藏：DOM 少一个 ---------- */
  await reset();
  const beforeHide = await countNodes();
  await openMenu();
  await pick("隐藏");
  report.hideDelta = beforeHide - (await countNodes());

  /* ---------- 删除 ---------- */
  await reset();
  const beforeDel = await countNodes();
  await openMenu();
  await pick("删除");
  report.deleteDelta = beforeDel - (await countNodes());

  /* ---------- 翻转按 canFlip 收口：文本节点上应是禁用的 ---------- */
  await reset();
  // 找一个 markdown 节点右键
  const mdPoint = await page.evaluate(() => {
    const el = document.querySelector(".react-flow__node-markdown");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 12) };
  });
  if (mdPoint) {
    await page.mouse.click(mdPoint.x, mdPoint.y, { button: "right" });
    await page.waitForTimeout(600);
    report.flipDisabledOnText = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cv-ctx-水平翻转"]');
      return el ? { disabled: el.disabled, title: el.title } : null;
    });
    await page.keyboard.press("Escape");
  }

  /* ---------- Esc 关菜单 ---------- */
  await reset();
  await openMenu();
  report.openedAgain = await page.locator('[data-testid="cv-node-menu"]').count();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  report.closedByEsc = await page.locator('[data-testid="cv-node-menu"]').count();
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();

  /*
   * 判定（2026-10-13 补）：这条原来只有 `console.log(report)` —— 在批跑里等于"静默不测"
   * （菜单项点了没反应、拖不动/拖得动反了，它都照样退 0）。
   *
   * 断的是**每一项右键操作的后果**（都是脚本自己量过的量）：
   *   · 菜单真开着，项也齐（复制 / 删除 / 锁定-解锁 / 隐藏-显示 / 四档层级 / 翻转两档）
   *   · 复制 → 节点 +1；隐藏 → DOM 少一个；删除 → DOM 少一个
   *     （React Flow 对 `hidden` 节点直接返回 null，所以"少一个"是真消失，不是被挡住）
   *   · 锁定 → 拖不动；解锁 → 拖得动 —— 这两条**互为对照**：只断一条的话，
   *     "拖不动"也可能是因为本来就没拖起来
   *   · 移到最前 → 节点顺序真的变了
   *   · 文本节点上的「水平翻转」是**禁用**的（canFlip 收口 —— 形状的翻转一直灰着过，
   *     就是这里没收口；而禁用了还得说清为什么，所以连 title 一起看）
   *   · Esc 能关掉菜单
   *
   * ⚠️ 故意**不断** `movedToEnd`：它成立的前提是"右键的正好是 DOM 里第一个节点"，
   * 而 openMenu 优先点**选中项**、还会跳过被遮住的节点 —— 拿它当判据会偶发假红。
   */
  const bad = [];
  /*
   * ⚠️ 比对必须用**子串**：菜单项文案可能带前后缀，数组全等
   * （`labels.includes("复制")`）对不上 —— 第一版就是这么全红的（假红）。
   *
   * （2026-10-14 补：图标已经从"字符前缀"换成 lucide 的 SVG 了，
   * 所以 `textContent` 里**没有**「⧉」「🗑」这类前缀了；子串比对照旧更稳 ——
   * 文案本身还可能带数量、快捷键之类的后缀。）
   */
  const labels = (report.menuItems ?? []).map((i) => i.t);
  const hasLabel = (word) => labels.some((t) => t.includes(word));

  if (report.menuOpened !== 1) bad.push("右键没弹出节点菜单");
  for (const want of ["复制", "删除", "移到最前", "移到最后", "上移一层", "下移一层", "水平翻转", "垂直翻转"]) {
    if (!hasLabel(want)) bad.push(`菜单里少了「${want}」`);
  }
  if (!hasLabel("锁定") && !hasLabel("解锁")) bad.push("菜单里既没有「锁定」也没有「解锁」");
  if (!hasLabel("隐藏") && !hasLabel("显示")) bad.push("菜单里既没有「隐藏」也没有「显示」");

  if (report.copyDelta !== 1) bad.push(`「复制」没让节点 +1：${report.copyDelta}`);
  if (report.hideDelta !== 1) bad.push(`「隐藏」没让那个节点从 DOM 里消失：${report.hideDelta}`);
  if (report.deleteDelta !== 1) bad.push(`「删除」没让那个节点从 DOM 里消失：${report.deleteDelta}`);
  if (report.lockedDidNotMove !== true) {
    bad.push(`锁定的节点被拖动了：dx=${report.lockedDrag?.dx} dy=${report.lockedDrag?.dy}`);
  }
  if (report.menuHasUnlock !== 1) bad.push("锁上之后菜单里没有「解锁」");
  if (report.unlockedMoved !== true) bad.push("解锁之后仍然拖不动 —— 锁定/解锁至少有一头是假的");
  if (report.orderChanged !== true) bad.push("「移到最前」没有改变节点顺序");
  if (!report.flipDisabledOnText) {
    bad.push("没找到 markdown 节点，翻转收口这一条没被验到（静默少测）");
  } else if (report.flipDisabledOnText.disabled !== true) {
    bad.push("文本节点上的「水平翻转」没被禁用（canFlip 没收口：点了不会有任何变化）");
  } else if (!report.flipDisabledOnText.title) {
    bad.push("「水平翻转」禁用了却没说为什么（title 为空）");
  }
  if (report.openedAgain !== 1) {
    bad.push("第二次右键没弹出菜单（Esc 那一步等于没测）");
  } else if (report.closedByEsc !== 0) {
    bad.push("按 Esc 没关掉右键菜单");
  }
  if (bad.length) {
    console.error("✗ 节点右键菜单：" + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 右键菜单：项齐全 / 复制·隐藏·删除各 +1·-1·-1 / 锁了拖不动、解锁拖得动 / 移到最前改顺序 / 文本节点翻转禁用且有说明 / Esc 关得掉");
  }
}
