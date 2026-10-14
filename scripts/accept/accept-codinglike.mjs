import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, readStoreFile, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**应用详情 + 喜欢（含重启后还在）**（§180）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 种一个 `.html` 产物 → 创作广场里就有一个应用。
 *
 * 六条断言：
 * ① 卡片上有「查看详情」（逐字）
 * ② ⭐ 点开之后详情面板出来，标签是**应用详情**（逐字），里面有名字
 * ③ ⭐ 点「喜欢」→ 按钮变成「**取消喜欢**」（两句话都是逐字证据）
 * ④ 再点一次 → 变回「喜欢」
 * ⑤ ⭐⭐ **重启之后喜欢还在**（`coding-likes.json` 而不是 localStorage —— §156 的教训）
 * ⑥ 界面上**不给假的点赞数**（本机版只有你自己）
 */
const DATA = ".verify/codinglike-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const ARTIFACTS = path.join(DATA, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });

/** 一个能被创作广场认出来的网页产物（`isWebApp` = `.html` 结尾）。 */
fs.writeFileSync(path.join(ARTIFACTS, "日报生成器.html"), "<html><body><h1>日报</h1></body></html>", "utf8");

const PORT = 9332;
const out = {};

const boot = async () =>
  bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });

/**
 * 打开创作广场。
 *
 * ⚠️ 入口是 `+` 菜单里的「创作广场」（`wb-add-coding`），**不是左侧导航** ——
 * 照已有验收 `accept-coding.mjs` 的做法（我原来猜成 `wb-nav-coding` 白等 30 秒）。
 */
const openCoding = async (page) => {
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-add-coding"]').click();
  await page.waitForTimeout(2000);
};

const likeText = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="wb-coding-like"]')?.textContent?.trim() ?? "");

let child = null;
try {
  /* ── 第一次启动 ── */
  const first = await boot();
  child = first.child;
  if (!first.ok) {
    console.error("[诊断] 应用输出尾部：\n" + (first.getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b1 = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b1);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await openCoding(page);

  /* ① 卡片上的按钮 */
  out.cardDetailBtn = await page.locator('[data-testid="wb-coding-detail-日报生成器"]').count();

  /* ② 详情面板 */
  await page.locator('[data-testid="wb-coding-detail-日报生成器"]').click();
  await page.waitForTimeout(900);
  out.detailShown = (await page.locator('[data-testid="wb-coding-detail"]').count()) > 0;
  out.tab = await page.evaluate(
    () => document.querySelector('[data-testid="wb-coding-detail-tab"]')?.textContent?.trim() ?? "",
  );
  out.name = await page.evaluate(
    () => document.querySelector('[data-testid="wb-coding-detail-name"]')?.textContent?.trim() ?? "",
  );

  /*
   * ⚠️ 2026-10-13 补：`wb-coding-detail-close` 与 `wb-coding-like-note` **原来没有任何脚本引用过**
   * （`src/` 的 `data-testid` 与 `scripts/accept/` 交叉，见 HANDOFF §208 那份零覆盖清单）——
   * 详情面板的「关闭」与那句"不给假的点赞数"正属于"没人点过 ⇒ 烂了也没人知道"的那一类（§201）。
   */
  out.detailCloseBtn = await page.locator('[data-testid="wb-coding-detail-close"]').count();
  out.likeNote = await page.evaluate(
    () => document.querySelector('[data-testid="wb-coding-like-note"]')?.textContent?.trim() ?? "",
  );

  /* ③ 喜欢 → 取消喜欢 */
  out.likeBefore = await likeText(page);
  await page.locator('[data-testid="wb-coding-like"]').click();
  await page.waitForTimeout(900);
  out.likeAfter = await likeText(page);
  out.fileAfterLike = fs.existsSync(path.join(DATA, "coding-likes.json"))
    ? readStoreFile(path.join(DATA, "coding-likes.json"))
    : null;

  /* ⑥ 界面上不许出现编出来的点赞数 */
  out.detailText = await page.evaluate(
    () => document.querySelector('[data-testid="wb-coding-detail"]')?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
  );
  out.shot = await shot(page, "codinglike.png");

  /*
   * ⚠️ 「关闭」要断**后果**：点下去详情面板真的消失（不是"点了没报错"）。
   * 放在截图之后 —— 截图留给人的样子应当是**详情打开着**的那一屏。
   */
  await page.locator('[data-testid="wb-coding-detail-close"]').click();
  await page.waitForTimeout(500);
  out.detailGoneAfterClose = (await page.locator('[data-testid="wb-coding-detail"]').count()) === 0;

  await b1.close();
  await killTree(first.child);
  child = null;

  /* ── 重启之后再看一眼（⑤ 的证明） ── */
  await new Promise((r) => setTimeout(r, 1500));
  const second = await boot();
  child = second.child;
  if (!second.ok) {
    console.error("[诊断] 第二次启动失败：\n" + (second.getLog() || "(空)").slice(-800));
    await killTree(child);
    process.exit(1);
  }

  const b2 = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page2 = await waitForPage(b2);
  if (!page2) throw new Error(NO_PAGE_HINT);
  await page2.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await openCoding(page2);
  await page2.locator('[data-testid="wb-coding-detail-日报生成器"]').click();
  await page2.waitForTimeout(1200);
  out.likeAfterRestart = await likeText(page2);

  /* ④ 再点一次 → 变回「喜欢」 */
  await page2.locator('[data-testid="wb-coding-like"]').click();
  await page2.waitForTimeout(900);
  out.likeAfterToggle = await likeText(page2);

  await b2.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (out.cardDetailBtn !== 1) bad.push("卡片上没有「查看详情」按钮");
  if (!out.detailShown) bad.push("点了「查看详情」详情面板没出来");
  if (out.tab !== "应用详情") bad.push(`详情标签与证据不符：${out.tab}`);
  if (out.name !== "日报生成器") bad.push(`详情里的名字不对：${out.name}`);

  /* 补的那两条（零覆盖清单里的 `wb-coding-detail-close` / `wb-coding-like-note`，§208） */
  if (out.detailCloseBtn !== 1) bad.push("详情面板上没有「关闭」（×）按钮");
  if (!(out.likeNote ?? "").includes("不给假的点赞数")) {
    bad.push(`详情里那句"不给假的点赞数"没了或变了：${out.likeNote}`);
  }
  if (!out.detailGoneAfterClose) bad.push("点了「关闭」详情面板没消失");

  if (out.likeBefore !== "喜欢") bad.push(`初始按钮文案不对：${out.likeBefore}`);
  if (out.likeAfter !== "取消喜欢") bad.push(`点过之后按钮文案不对：${out.likeAfter}`);
  if ((out.fileAfterLike?.liked ?? []).length !== 1) {
    bad.push(`喜欢没落盘或落盘形状不对：${JSON.stringify(out.fileAfterLike)}`);
  }

  if (out.likeAfterRestart !== "取消喜欢") {
    bad.push(`⭐ 重启之后喜欢没了（应当还是「取消喜欢」）：${out.likeAfterRestart}`);
  }
  if (out.likeAfterToggle !== "喜欢") bad.push(`再点一次应当变回「喜欢」：${out.likeAfterToggle}`);

  /* ⑥ 没有编造的数字 */
  if (/(^|\\D)\\d+\\s*人?喜欢/.test(out.detailText ?? "")) {
    bad.push(`⭐ 详情里出现了编出来的点赞数：${out.detailText}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 应用详情与喜欢成立：详情逐字 / 喜欢→取消喜欢 / 重启后还在 / 再点变回 / 没有编造点赞数");
  }
}
