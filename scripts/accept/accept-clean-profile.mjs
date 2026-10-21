// 干净 profile（M-08，2026-10-21）—— 常驻回归。
//
// 主人报的第 6 条：装完有两条"我们的任务"。根因是 dev 与装机版共用 profile。
// 判据：
//   ① 干净 dataDir → 启动 → 任务中心 0 条（空态在、没有任务行）；
//   ② 写一条假会话进该 dataDir → 重启 → 能读回来（证明是**隔离**，不是读不到）。
import { chromium } from "playwright";
import { bootApp, connectWithRetry, failOnMarks, freshDir, killLeftovers, killTree, pickPort, sleep, verdict, waitForPage } from "./harness.mjs";

failOnMarks();

const bad = [];
const note = (m) => console.log("   " + m);

const DATA = ".verify/accept-clean-profile-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/** 起一次、读任务中心、关掉。 */
async function inspect(label) {
  const port = await pickPort([9927]);
  const booted = await bootApp({ port, dataDir: DATA, timeoutMs: 40_000 });
  if (!booted.ok) throw new Error(`${label}：应用没起来（${booted.getLog().slice(-400)}）`);
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`, 2);
  const page = await waitForPage(browser);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await sleep(1800);
  await page.locator('[data-testid="wb-center-open"]').click();
  await sleep(900);
  const empty = await page.locator('[data-testid="wb-center-empty"]').count();
  const rows = await page.locator('[data-testid^="wb-center-row-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-testid") ?? ""),
  );
  const counts = await page.locator('[data-testid^="wb-center-row-"]').count();
  const titles = await page.locator('[data-testid^="wb-center-row-"]').allInnerTexts().catch(() => []);
  return { browser, booted, page, empty, rows: counts, ids: rows, titles };
}

try {
  /* ① 干净目录 → 任务中心为空 */
  const first = await inspect("第一次启动");
  if (first.rows !== 0) bad.push(`干净 profile 里任务中心有 ${first.rows} 条任务（${first.ids.join(",")}）`);
  if (!first.empty) bad.push("干净 profile 里没有任务中心空态（可能压根没读到）");
  else note("干净 profile：任务中心 0 条 + 空态在 ✓");
  await first.page.screenshot({ path: ".verify/mset-08-clean-center.png" });

  /* ② 用应用自己的口子造一条任务（输入区发一条）→ 重启 → 读得回来 */
  await first.page.locator('[data-testid="wb-nav-home"]').click();
  await sleep(600);
  const composer = first.page.locator('[data-testid="wb-composer-input"]');
  await composer.fill("干净 profile 复测任务：这一条应该跨重启还在");
  await first.page.locator('[data-testid="wb-send"]').click();
  await sleep(4000);
  await first.page.locator('[data-testid="wb-center-open"]').click();
  await sleep(1200);
  const created = await first.page.locator('[data-testid^="wb-center-row-"]').count();
  const createdIds = await first.page
    .locator('[data-testid^="wb-center-row-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid") ?? ""));
  if (created < 1) bad.push(`发了一条任务但任务中心里没有（${created} 条）—— 这条是用来证明"读得回来"的`);
  else note(`写完一条任务，任务中心 ${created} 条`);
  await first.browser.close().catch(() => undefined);
  await killTree(first.booted.child);
  await killLeftovers();
  await sleep(1500);

  const second = await inspect("第二次启动");
  if (created >= 1 && second.rows < 1) {
    bad.push("重启之后读不到刚建的任务（数据目录可能没被复用）");
  } else if (created >= 1) {
    /* 用**任务 id** 对身份（标题可能被模型/首条消息改写，拿它比不可靠） */
    const same = createdIds.every((id) => second.ids.includes(id));
    if (!same) bad.push(`重启之后任务 id 对不上：前 ${createdIds.join(",")} / 后 ${second.ids.join(",")}`);
    else note(`重启之后同一批任务还在（${second.rows} 条，id 一致）✓`);
  }
  await second.page.screenshot({ path: ".verify/mset-08-second-boot.png" });
  await second.browser.close().catch(() => undefined);
  await killTree(second.booted.child);
  await killLeftovers();
} catch (e) {
  bad.push("异常: " + String(e).slice(0, 300));
} finally {
  await killLeftovers();
}

verdict(bad, "干净 profile 成立：任务中心 0 条 + 空态在；隔离目录被同一进程复用（不是读不到）");
