import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
const DATA = "D:/DoubaoWorkClone/.verify/nm2";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9700"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9700");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};
const shots = "D:/DoubaoWorkClone/.verify/shots-final";
const countNodes = () => page.locator(".react-flow__node").count();

/** 重置到干净画布：重载 + 打开画布。 */
const reset = async () => {
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1200);
  const open = await page.locator('[data-testid="wb-canvas"]').count();
  if (open === 0) {
    await page.locator('[data-testid="wb-canvas-toggle"]').click();
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
  report.menuItems = await page.$$eval('[data-testid^="cv-ctx-"]', (els) =>
    els.map((e) => ({ t: e.textContent.trim(), off: e.disabled })),
  );
  await page.screenshot({ path: path.join(shots, "wb-25-nodemenu.png") });

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
}
