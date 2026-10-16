import { chromium } from "playwright";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, readStoreFile, shot } from "./harness.mjs";

/**
 * 验收：**AI 文档的操作条**（§153）—— 缩写 / 扩写 / 润色 / 总结概括。
 *
 * ## 为什么单独一条
 *
 * `accept-doc.mjs` 进**无模型批跑**，而这条要真调模型。
 * 拆开是判据（§109）：**读脚本里有没有真调模型的调用**，不是"看起来像不像功能测试"。
 *
 * ## 三条断言
 *
 * ① 正文**真的被改写**（不是原样还回来 —— 那说明模型没干活却报了成功）
 * ② 历史里多了一版，且**由来写着「润色」**（用户能看出这一版是谁改的）
 * ③ 磁盘上也是改后的内容（不是只改了界面）
 *
 * ⚠️ 会真调模型（约 1 分钟）。
 */
const DATA = ".verify/doc-action-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9302;
const booted = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
const { child, ok, getLog } = booted;
/* 用实际端口（bootApp 换过端口时它与首选不同） */
PORT = booted.port;
if (!ok) {
  console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
  await killTree(child);
  process.exit(1);
}

/** 原文故意写得啰嗦且有一处明显可改的地方，好让"润色"有的可做。 */
const ORIGINAL =
  "这个星期我们做了三件事情，第一个事情是把那个登录的问题修好了，第二个事情是把这个报表做出来了，第三个事情是跟客户开会讨论了后面的计划。";

const out = {};
try {
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const ctx = b.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-add-doc"]').click();
  await page.waitForTimeout(1200);

  await page.locator('[data-testid="wb-doc-title"]').fill("周报草稿");
  await page.locator('[data-testid="wb-doc-body"]').fill(ORIGINAL);
  await page.waitForTimeout(1200);
  out.before = await page.locator('[data-testid="wb-doc-body"]').inputValue();

  await page.locator('[data-testid="wb-doc-act-refine"]').click();
  /*
   * ⭐ **往返期间正文必须只读**（2026-10-16，审计 P87）：模型回来是整篇替换，
   * 期间还能编辑的话，"顺手改两句"会被静默吃掉。这里在读**当下**的那一刻就判，
   * 所以放在等结果之前（等完了 `busy` 已经落回 false，就看不到这个状态了）。
   */
  {
    /*
     * ⚠️ 要**轮询**着看：点下去之后 React 还得提交一次渲染，属性才会出现 ——
     * 点完立刻读会读到 false，那是"还没渲染到"，不是"没做只读"（第一版就这么误判了一次）。
     */
    const until = Date.now() + 5000;
    let seen = false;
    while (Date.now() < until) {
      seen = await page.evaluate(
        () => document.querySelector('[data-testid="wb-doc-body"]')?.hasAttribute("readonly") ?? false,
      );
      if (seen) break;
      await page.waitForTimeout(120);
    }
    out.readOnlyDuringRewrite = seen;
  }
  /* 等正文变掉（模型往返），最多 90 秒 */
  const deadline = Date.now() + 90000;
  let now = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    now = await page.locator('[data-testid="wb-doc-body"]').inputValue();
    if (now && now !== out.before) break;
  }
  out.after = now;
  out.note = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-note"]')?.textContent?.trim() ?? "",
  );

  await page.locator('[data-testid="wb-doc-history-btn"]').click();
  await page.waitForTimeout(400);
  out.reasons = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-doc-version-reason")).map((e) => (e.textContent ?? "").trim()),
  );
  await page.waitForTimeout(1200);
  const onDisk = readStoreFile(path.join(DATA, "docs.json"));
  out.diskBody = (onDisk?.[0]?.body ?? "").slice(0, 40);
  out.diskVersions = onDisk?.[0]?.versions?.length ?? 0;
  out.shot = await shot(page, "doc-refine.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);
  /* P87：往返期间不许还能编辑（还能编辑 = 用户打的字会被整篇替换吃掉） */
  if (out.readOnlyDuringRewrite !== true) {
    bad.push(
      `⭐ 改写往返期间正文还能编辑（readonly=${JSON.stringify(out.readOnlyDuringRewrite)}）—— 期间打的字会被模型结果整篇覆盖`,
    );
  }
  /* ① 真的被改写 */
  if (!out.after || out.after === out.before) {
    bad.push("点了「润色」正文没变 —— 模型没干活，或者结果没落回去");
  }
  /* ② 历史里那一版写着由来 */
  if (!(out.reasons ?? []).some((r) => r.includes("润色"))) {
    bad.push(`历史里没有「润色」这一版：${JSON.stringify(out.reasons)}`);
  }
  /* ③ 磁盘跟上 */
  if (!(out.diskBody ?? "").trim()) bad.push("磁盘上的正文是空的");
  else if (!out.after.includes(out.diskBody.slice(0, 10))) {
    bad.push(`磁盘与界面不一致：磁盘「${out.diskBody}」`);
  }
  if ((out.diskVersions ?? 0) < 4) bad.push(`磁盘上版本数偏少：${out.diskVersions}`);

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 操作条成立：润色真的改写了正文、历史里记着由来、磁盘也跟上了");
  }
}
