import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, readStoreFile, shot } from "./harness.mjs";

/**
 * 11.18 验收：左栏行的悬停 ⋯ 菜单 + 任务标题点击重命名。
 *
 * 两条都是从第三遍实机遍历里发现的：
 *   · `.verify\tour3\02-recent-context.png` —— 行是**悬停露出 ⋯**（不是右键）
 *   · `.verify\tour3\08-task-rename.png` —— 任务标题可点（标题后面跟一个 ›）
 *
 * 「移除任务」有一条必须验的语义：**只从列表去掉，不动磁盘上的产物** ——
 * 产物是用户的东西，移出一个任务不该顺手把文件删了。
 */
const DATA = "D:/DoubaoWorkClone/.verify/rowmenu-data";
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(DATA, "artifacts", "已有产物.docx"), "x", "utf8");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9620"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:9620");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};
const shots = "D:/DoubaoWorkClone/.verify/shots-final";

try {
  // 建两个任务
  for (const text of ["整理本周工作要点", "写一份竞品分析"]) {
    await page.locator('[data-testid="wb-composer-input"]').fill(text);
    await page.locator('[data-testid="wb-send"]').click();
    await page.waitForTimeout(2500);
  }
  report.taskCount = await page.locator('[data-testid^="wb-recent-"]').count();

  // ⋯ 平时应不可见（悬停才露）
  const moreBtn = page.locator('[data-testid^="wb-rowmenu-"]').first();
  report.hiddenOpacity = await moreBtn.evaluate((el) => getComputedStyle(el).opacity);

  // 悬停后应可见
  const row = page.locator('[data-testid^="wb-recent-"]').first();
  await row.hover();
  await page.waitForTimeout(500);
  report.hoverOpacity = await moreBtn.evaluate((el) => getComputedStyle(el).opacity);

  // 点开菜单
  await moreBtn.click();
  await page.waitForTimeout(700);
  report.menuOpened = await page.locator('[data-testid="wb-navmenu"]').count();
  report.menuItems = await page.$$eval('[data-testid^="wb-navmenu-"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, "")),
  );
  await shot(page, path.join(shots, "wb-21-rowmenu.png"));

  // 置顶
  await page.locator('[data-testid="wb-navmenu-置顶"]').click();
  await page.waitForTimeout(1200);
  report.pinnedAfterMenu = await page.locator('[data-testid^="wb-pinned-"]').count();
  const libPath = path.join(DATA, "library.json");
  report.libPinned = fs.existsSync(libPath) ? readStoreFile(libPath).pinned.length : null;

  // 取消置顶（菜单项应变成「取消置顶」）
  await page.locator('[data-testid^="wb-recent-"]').first().hover();
  await page.waitForTimeout(400);
  await page.locator('[data-testid^="wb-rowmenu-"]').first().click();
  await page.waitForTimeout(600);
  report.menuItemsAfterPin = await page.$$eval('[data-testid^="wb-navmenu-"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, "")),
  );
  await page.locator('[data-testid="wb-navmenu-取消置顶"]').click();
  await page.waitForTimeout(1000);
  report.pinnedAfterUnpin = await page.locator('[data-testid^="wb-pinned-"]').count();

  // 重命名任务（点标题进入改名）
  const titleBtn = page.locator('[data-testid="wb-task-title"]').first();
  if ((await titleBtn.count()) > 0) {
    await titleBtn.click();
    await page.waitForTimeout(600);
    report.renameInputShown = await page.locator('[data-testid="wb-task-rename-input"]').count();
    await page.locator('[data-testid="wb-task-rename-input"]').fill("季度复盘（改名后）");
    await page.locator('[data-testid="wb-task-rename-input"]').press("Enter");
    await page.waitForTimeout(1200);
    report.titleAfterRename = await page.locator('[data-testid="wb-task-title"]').first().textContent();
    report.rowAfterRename = await page
      .locator('[data-testid^="wb-recent-"]')
      .first()
      .textContent();
  } else {
    report.renameInputShown = "任务视图没打开";
  }

  // 移除任务：列表少一个，**产物文件必须还在**
  const before = await page.locator('[data-testid^="wb-recent-"]').count();
  await page.locator('[data-testid^="wb-recent-"]').first().hover();
  await page.waitForTimeout(400);
  await page.locator('[data-testid^="wb-rowmenu-"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-navmenu-移除"]').click();
  await page.waitForTimeout(1200);
  report.tasksBeforeRemove = before;
  report.tasksAfterRemove = await page.locator('[data-testid^="wb-recent-"]').count();
  report.artifactStillOnDisk = fs.existsSync(path.join(DATA, "artifacts", "已有产物.docx"));

  // 重启后应只剩一个任务
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2500));
  const child2 = spawn(
    "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
    [".", "--remote-debugging-port=9621"],
    { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
  );
  await new Promise((r) => setTimeout(r, 8000));
  const b2 = await connectWithRetry(chromium, "http://127.0.0.1:9621");
  const p2 = b2.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await p2.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await p2.waitForTimeout(1800);
  report.afterRestartRows = await p2.locator('[data-testid^="wb-recent-"]').count();
  report.afterRestartTitle = await p2.locator('[data-testid^="wb-recent-"]').first().textContent();
  await b2.close();
  child2.kill();
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();
}
