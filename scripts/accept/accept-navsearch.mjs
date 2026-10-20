// 左栏搜索（2026-10-17，V5 开工前清尾 §2.4 #3）—— 常驻回归。
//
// 那颗键原来是**装饰**（`disabled` + title "本机版是装饰：仿浏览器工具条"）；
// 现在它 = Phase 12.4 的会话全文检索（store 层 FTS + LIKE，CLI 的
// `ding sessions --search` 一直在用同一个口子）。同一批清尾里，「后退 / 前进」
// 两颗装饰键被**移除**（Ding 不是浏览器），这条脚本顺手把它们盯住。
//
// 判据都要"有真后果"（不是"点了没报错"）：
//   ① 搜索键可点、点了出搜索框；「后退 / 前进」不再存在；
//   ② 真发一条带探针词的消息（等这一轮 done = 会话记录落库）→ 搜探针词 → 至少一条命中，
//      且**片段里真有那个词**（片段不是编的）；
//   ③ 命中的任务**点了真的进那个任务**（任务视图打开，且进的是那一条）；
//   ④ 搜一个不可能出现的词 → 如实说「没搜到」（不是空列表糊过去）。
import { chromium } from "playwright";
import { bootApp, connectWithRetry, failOnMarks, finishedTurns, freshDir, killTree, pickPort, verdict, waitTurnEnd, dismissFirstRunIfShown } from "./harness.mjs";

/* ⚠️ 审计 G15 的口径：只印 ✗ 不改退出码的脚本等于没测 */
failOnMarks();

const DATA = ".verify/accept-navsearch-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const booted = await bootApp({ port: await pickPort([12661]), dataDir: DATA, timeoutMs: 40_000 });
if (!booted.ok) {
  console.error("[诊断] 应用输出尾部：\n" + (booted.getLog() || "(空)").slice(-1200));
  await killTree(booted.child);
  process.exit(1);
}
const browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20_000 });
await dismissFirstRunIfShown(page);
await page.waitForTimeout(1500);

const bad = [];
const note = (m) => console.log("   " + m);
/** 探针词：不会自然出现的组合，中文 + 拉丁混排（顺带验 LIKE/FTS 两条路都通）。 */
const PROBE = "探针词-navsw-7788";

try {
  /* ---------- ① 键的形态：搜索可点；后退/前进已移除 ---------- */
  const btn = page.locator('[data-testid="wb-search"]');
  if ((await btn.count()) !== 1) bad.push("左栏没有搜索键（wb-search）");
  const disabled = await btn
    .evaluate((el) => el.hasAttribute("disabled"))
    .catch(() => true);
  if (disabled) bad.push("⭐ 搜索键还是 disabled（清尾口径：它必须真做）");
  const decorativeGone = await page.evaluate(
    () =>
      document.querySelectorAll('[aria-label="后退"]').length === 0 &&
      document.querySelectorAll('[aria-label="前进"]').length === 0,
  );
  if (!decorativeGone) bad.push("「后退 / 前进」两颗装饰按钮还在（清尾口径：移除）");
  note("搜索键可点；后退/前进已不在");

  /* ---------- ② 发一条带探针词的消息，等这一轮真的结束 ---------- */
  const before = await finishedTurns(page);
  await page.locator('[data-testid="wb-composer-input"]').fill(PROBE + " 记一下这件事");
  await page.locator('[data-testid="wb-send"]').click();
  await waitTurnEnd(page, before);
  note("探针消息这一轮已结束（会话记录里有 done）");

  /* ---------- ③ 搜探针词：有命中，片段里真有它 ---------- */
  await btn.click();
  await page.waitForTimeout(400);
  const input = page.locator('[data-testid="wb-navsearch-input"]');
  if ((await input.count()) !== 1) {
    bad.push("点了搜索键没有出搜索框（wb-navsearch-input）");
  } else {
    await input.fill(PROBE);
    await page.waitForTimeout(1200); /* 防抖 220ms + 一次 IPC 往返 */
    const hits = await page.$$eval('[data-testid^="wb-navsearch-hit-"]', (els) =>
      els.map((e) => ({ testid: e.getAttribute("data-testid") ?? "", isButton: e.tagName.toLowerCase() === "button" })),
    );
    if (hits.length < 1) bad.push(`搜「${PROBE}」一条命中都没有（会话检索没接上？）`);
    const listText = (await page.locator('[data-testid="wb-navsearch-list"]').textContent()) ?? "";
    if (hits.length >= 1 && !listText.includes(PROBE)) {
      bad.push("命中的行里没有探针词（片段不是真内容）");
    }
    note(`命中 ${hits.length} 条`);

    /* ---------- ④ 命中的任务点了真的进那个任务 ---------- */
    /* 可打开的那条渲染成 `<button>`；其余（命令行/对话记录）是只读行 —— 不给点不动的假按钮 */
    const taskHit = hits.find((h) => h.isButton);
    if (!taskHit) {
      bad.push("命中里没有可打开的任务（探针消息那条本该是可打开的任务会话）");
    } else {
      const raw = taskHit.testid.slice("wb-navsearch-hit-".length);
      const expectId = raw.startsWith("task-") ? raw.slice("task-".length) : raw;
      await page.locator(`[data-testid="${taskHit.testid}"]`).click();
      await page.waitForTimeout(700);
      const taskOpen = await page.locator('[data-testid="wb-task"]').count();
      if (taskOpen !== 1) bad.push("点了命中没有进任务视图");
      const titleRaw = ((await page.locator('[data-testid="wb-task-title"]').textContent().catch(() => "")) ?? "").trim();
      /* 视图标题按钮带一个装饰性的 `›` 尾巴（`TaskView.tsx`），比对前剥掉 */
      const title = titleRaw.replace(/[›>\s]+$/, "");
      if (!title) bad.push("进的任务视图没有标题");
      /*
       * 进的是**那一条**：左栏那一行（wb-recent-<id>）的标题要与任务视图的标题一致。
       * 行可能因为"归了项目/超出 12 条"不出现 —— 那时至少要求视图的标题非空（上面已断）。
       */
      const rowTitle = await page
        .locator(`[data-testid="wb-recent-${expectId}"] .wb-nav-row-title`)
        .textContent()
        .catch(() => null);
      if (rowTitle !== null && rowTitle.trim() !== title) {
        bad.push(`点开的不是那一条（视图标题「${title}」≠ 左栏那一行「${rowTitle.trim()}」）`);
      }
      note(`点开命中 → 任务「${title}」`);

      /* ---------- ⑤ 搜不可能出现的词：如实说「没搜到」 ---------- */
      await btn.click();
      await page.waitForTimeout(400);
      const input2 = page.locator('[data-testid="wb-navsearch-input"]');
      if ((await input2.count()) === 1) {
        await input2.fill("绝不可能出现的词zzzqqq-918273");
        await page.waitForTimeout(1200);
        const emptyText = (await page.locator('[data-testid="wb-navsearch-list"]').textContent()) ?? "";
        if (!emptyText.includes("没搜到")) bad.push("搜不存在的词没有如实说「没搜到」");
      }
    }
  }
} catch (e) {
  bad.push("异常：" + String(e).slice(0, 200));
} finally {
  try {
    await browser.close();
  } catch {
    /* 已经关了 */
  }
  await killTree(booted.child);
}

verdict(bad, "左栏搜索：可点 / 搜得中 / 点得开 / 搜不到说真话；后退前进已移除");
