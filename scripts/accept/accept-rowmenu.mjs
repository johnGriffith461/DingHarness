import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import {
  NO_PAGE_HINT,
  bootApp,
  connectWithRetry,
  failOnMarks,
  freshDir,
  killTree,
  pickPort,
  readStoreFile,
  shot,
  verdict,
  waitForPage,
} from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

/**
 * 11.18 验收：左栏行的悬停 ⋯ 菜单 + 任务标题点击重命名。
 *
 * 两条都是从第三遍实机遍历里发现的：
 *   · `.verify\tour3\02-recent-context.png` —— 行是**悬停露出 ⋯**（不是右键）
 *   · `.verify\tour3\08-task-rename.png` —— 任务标题可点（标题后面跟一个 ›）
 *
 * 「移除任务」有一条必须验的语义：**只从列表去掉，不动磁盘上的产物** ——
 * 产物是用户的东西，移出一个任务不该顺手把文件删了。
 *
 * ⚠️ 两处 2026-10-16 的订正（把清单外的脚本并进批跑那一轮做的）：
 *   · **启动改用 `bootApp`**：原来自己 `spawn` + `waitForPort` + `connectOverCDP`，
 *     这台机器上存在「TCP 通、Electron 的调试服务器不答」的端口区间，裸写法会卡死；
 *   · **开头补两件事**：先回首页、**等第一条任务行真的出现**再往下走。
 *     批跑用的是全新隔离数据目录（**空态**），而这条脚本第 2 步就 `hover()`
 *     左栏第一行 —— 行还没建出来时 hover 等不到元素，报的是
 *     `Timeout … waiting for locator('[data-testid^="wb-recent-"]')`（看着像产品坏了）。
 *     顺带把"发出去的那一条真的变成一行任务"也变成**可判**的。
 */
const DATA = ".verify/rowmenu-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(path.join(DATA, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(DATA, "artifacts", "已有产物.docx"), "x", "utf8");

const booted = await bootApp({ port: await pickPort([12620]), dataDir: DATA, timeoutMs: 40_000 });
if (!booted.ok) {
  console.error("[诊断] 应用输出尾部：" + (booted.getLog() || "(空)").slice(-1200));
  await killTree(booted.child);
  process.exit(1);
}
const browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
const page = await waitForPage(browser);
if (!page) throw new Error(NO_PAGE_HINT);
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};
const shots = ".verify/shots-final";

/** 发一句、并等它真的变成左栏的一行（空态下先建行，见文件头那段说明）。 */
const sendAndWaitRow = async (text, wantRows) => {
  /*
   * ⚠️ **每次发之前先回首页**：任务视图里的输入区现在会「接着聊」（§147）——
   * 第一次发完界面就停在那个任务里，再填一句是**追加到同一段对话**，
   * 左栏不会多出第二行（实测：两次发完仍然只有 1 行）。回首页才是一次独立发起。
   */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(700);
  await page.locator('[data-testid="wb-composer-input"]').fill(text);
  await page.locator('[data-testid="wb-send"]').click();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    if ((await page.locator('[data-testid^="wb-recent-"]').count()) >= wantRows) return true;
  }
  return false;
};

try {
  /* 先回首页（输入区只在那里），再建两个任务 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);
  const rows1 = await sendAndWaitRow("整理本周工作要点", 1);
  const rows2 = await sendAndWaitRow("写一份竞品分析", 2);
  report.rowsBuilt = { first: rows1, second: rows2 };
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
  await browser.close().catch(() => undefined);
  await killTree(booted.child);
  await new Promise((r) => setTimeout(r, 1500));
  /* 重启也走 `bootApp`（同一个理由：裸 spawn + 固定 sleep 会卡在连 CDP 那一步） */
  const booted2 = await bootApp({ port: await pickPort([12721]), dataDir: DATA, timeoutMs: 40_000 });
  if (!booted2.ok) throw new Error("重启后应用没起来：" + (booted2.getLog() || "").slice(-300));
  const b2 = await connectWithRetry(chromium, `http://127.0.0.1:${booted2.port}`);
  const p2 = await waitForPage(b2);
  if (!p2) throw new Error(NO_PAGE_HINT);
  await p2.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await p2.waitForTimeout(1800);
  report.afterRestartRows = await p2.locator('[data-testid^="wb-recent-"]').count();
  report.afterRestartTitle = await p2
    .locator('[data-testid^="wb-recent-"]')
    .first()
    .textContent()
    .catch(() => null);
  await b2.close();
  await killTree(booted2.child);
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  await killTree(booted.child);
}

/*
 * ── 判定（2026-10-16 补）──
 *
 * 这条脚本原来**只有 `console.log(report)`** —— 在批跑里那是"跑通但没有判定"
 * （`verify-acceptances.mjs` 的 `no-judge` 那一类，等于没测）。
 */
const bad = [];
if (!report.rowsBuilt?.first) bad.push("发第一句之后左栏没建出任务行（空态下「先建行」这一步就断了）");
if (!report.rowsBuilt?.second) bad.push("发第二句之后左栏仍只有一行");
if (report.taskCount !== 2) bad.push(`发了两句，左栏却有 ${report.taskCount} 行`);
/* ⋯ 平时不可见、悬停才露（实机形态；CSS 里 opacity 0 → 1） */
if (!(Number(report.hiddenOpacity) < 0.5)) bad.push(`⋯ 平时就是可见的（opacity=${report.hiddenOpacity}）—— 悬停露出这条形态变了`);
if (!(Number(report.hoverOpacity) > 0.5)) bad.push(`悬停之后 ⋯ 还是不可见（opacity=${report.hoverOpacity}）—— 点不到它`);
if (!report.menuOpened) bad.push("⋯ 点不开菜单（wb-navmenu）");
if (!(report.menuItems ?? []).includes("置顶")) bad.push(`菜单里没有「置顶」：${JSON.stringify(report.menuItems)}`);
/* 置顶：界面出现置顶行 + 落盘 */
if (!(report.pinnedAfterMenu > 0)) bad.push("点了「置顶」界面上没有置顶行");
if (report.libPinned !== 1) bad.push(`置顶没落盘（library.json 的 pinned = ${JSON.stringify(report.libPinned)}）`);
/* 取消置顶：菜单项应变成「取消置顶」 */
if (!(report.menuItemsAfterPin ?? []).includes("取消置顶")) {
  bad.push(`已置顶的行，菜单里没有「取消置顶」：${JSON.stringify(report.menuItemsAfterPin)}`);
}
if (report.pinnedAfterUnpin !== 0) bad.push(`取消置顶之后还剩 ${report.pinnedAfterUnpin} 行置顶`);
/* 重命名 */
if (report.renameInputShown !== 1) bad.push("点任务标题没有进改名（wb-task-rename-input 没出现）");
else if (!String(report.titleAfterRename ?? "").includes("改名后")) {
  bad.push(`改名没生效：${JSON.stringify(report.titleAfterRename)}`);
} else if (!String(report.rowAfterRename ?? "").includes("改名后")) {
  bad.push(`改名没反映到左栏那一行：${JSON.stringify(report.rowAfterRename)}`);
}
/* 移除任务：列表少一个，**产物文件必须还在**（这一条是这条脚本的语义核心） */
if (report.tasksAfterRemove !== report.tasksBeforeRemove - 1) {
  bad.push(`「移除」之后行数不对（${report.tasksBeforeRemove} → ${report.tasksAfterRemove}）`);
}
if (!report.artifactStillOnDisk) bad.push("⚠️ 移除任务把磁盘上的产物文件也删了 —— 产物是用户的东西");
/* 重启后那一条还在；被移除的那条**不许回来**（移除要真的落盘） */
if (report.afterRestartRows !== 1) bad.push(`重启后左栏不是 1 行，而是 ${report.afterRestartRows}`);
else if (!String(report.afterRestartTitle ?? "").trim()) bad.push("重启后那一行没有文字（标题没落盘）");
else if (String(report.afterRestartTitle ?? "").includes("改名后")) {
  bad.push("被「移除」的那条重启后又回来了 —— 移除只改了内存，没落盘");
}

verdict(bad, "左栏行菜单成立：⋯ 悬停才露 / 置顶与取消置顶落盘 / 标题可改名 / 移除不动产物 / 重启后还在");
