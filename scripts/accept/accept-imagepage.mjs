import { chromium } from "playwright";
import fs from "node:fs";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage, expandComposerMore } from "./harness.mjs";

/**
 * 验收：**生成图片独立页**（§165，对应 `chat/create-image`）。
 *
 * ## 这条**不调模型、也不真出图**（进批跑）
 *
 * 出图要花钱、也要等，而且这个环境**未必配了图像通道** ——
 * 所以这条验的是**这一页该有的东西**，以及**没有通道时它诚不诚实**：
 *
 * ① `+` 菜单 → 图片生成 → 页面打开，标题是证据里那句
 * ② ⭐ **要么给表单、要么说清为什么**：有表单时占位是「描述你想生成的图片」（逐字），
 *    没通道时说清缺什么（**绝不摆一个点了没反应的按钮**）
 * ③ 尺寸那一套在（三档模式 × 比例 × 档位，且**显示算出来的真实尺寸**）
 * ④ 「最近生成」的空态在
 * ⑤ 不点生成 —— 这条验收**不动这台机器上的钱和网络**
 */
const DATA = ".verify/imagepage-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

/* ⚠️ 2026-10-16（审计 G06/G07）：bootApp 会换端口重试 —— 下面用的是它返回的实际端口，不再假设给哪个就用哪个 */
let PORT = 9316;
const out = {};
let child = null;
let ok = false;
let getLog = () => "";

const boot = async () => {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  /* 用实际端口（bootApp 换过端口时它与首选不同） */
  PORT = r.port;
  child = r.child;
  ok = r.ok;
  getLog = r.getLog;
  return ok;
};

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* ── ① 入口 ── */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(700);
  await expandComposerMore(page);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  out.menuHasImage = await page.evaluate(
    () => document.querySelector('[data-testid="wb-add-pop"]')?.textContent?.includes("图片生成") ?? false,
  );
  await page.locator('[data-testid="wb-add-image"]').click();
  /*
   * 等**真条件**（同 accept-videopage 那次修正）：面板挂载时要去列图片模型，
   * 主进程侧有 15 秒超时、超时给诚实的空态。固定等 1500ms 曾在"上游慢"时报过假案。
   * 这里等的结果是"两种诚实状态之一出现了"（有 prompt 输入框，或那段说明）。
   */
  for (let i = 0; i < 40; i += 1) {
    const settled = await page.evaluate(
      () =>
        Boolean(document.querySelector('[data-testid="gen-prompt"]')) ||
        Boolean(document.querySelector(".gen-panel-empty")?.textContent?.trim()),
    );
    if (settled) break;
    await page.waitForTimeout(500);
  }
  out.opened = (await page.locator('[data-testid="wb-imagepage"]').count()) > 0;
  out.title = await page.evaluate(() => document.querySelector(".wb-imagepage-head h2")?.textContent?.trim() ?? "");
  out.tag = await page.evaluate(() => document.querySelector(".wb-imagepage-tag")?.textContent?.trim() ?? "");

  /* ── ② 要么表单、要么说清为什么 ── */
  out.hasPanel = (await page.locator('[data-testid="gen-panel-image"]').count()) > 0;
  out.hasPrompt = (await page.locator('[data-testid="gen-prompt"]').count()) > 0;
  out.promptPlaceholder = await page.evaluate(
    () => document.querySelector('[data-testid="gen-prompt"]')?.getAttribute("placeholder") ?? "",
  );
  /** 面板里那段"没有通道"的说明（没有 testid，按类名读）。 */
  out.panelEmptyText = await page.evaluate(
    () => document.querySelector(".gen-panel-empty")?.textContent?.trim() ?? "",
  );
  out.hasRunButton = (await page.locator('[data-testid="gen-run"]').count()) > 0;

  /* ── ③ 尺寸那一套 ── */
  out.sizeModes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="gen-size-mode-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("gen-size-mode-", ""),
    ),
  );
  out.tiers = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="gen-tier-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("gen-tier-", ""),
    ),
  );
  out.sizeOut = await page.evaluate(
    () => document.querySelector('[data-testid="gen-size-out"]')?.textContent?.trim() ?? "",
  );
  /* 切到"按比例"模式，看它给出的尺寸是不是真的跟着变 */
  if (out.hasPrompt) {
    await page.locator('[data-testid="gen-size-mode-ratio"]').click();
    await page.waitForTimeout(300);
    /*
     * ⚠️ 换一个**非 1:1** 的比例再比：默认 1:1 恰好也是 1024x1024，
     * 拿它去断言"尺寸变了"必然误判 —— 不是没重算，是这两个本来就一样。
     */
    await page.locator('[data-testid="gen-ratio"]').selectOption("16:9");
    await page.waitForTimeout(400);
    out.sizeOutRatio = await page.evaluate(
      () => document.querySelector('[data-testid="gen-size-out"]')?.textContent?.trim() ?? "",
    );
  }

  /* ── ④ 最近生成的空态 ── */
  out.recentTitle = await page.evaluate(
    () => document.querySelector('[data-testid="wb-imagegen-recent"] h3')?.textContent?.trim() ?? "",
  );
  out.recentEmpty = await page.evaluate(
    () => document.querySelector('[data-testid="wb-imagegen-empty"]')?.textContent?.trim() ?? "",
  );
  out.shot = await shot(page, "imagepage.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.menuHasImage) bad.push("+ 菜单里没有「图片生成」");
  if (!out.opened) bad.push("点入口没进生成图片页");
  if (out.title !== "图片生成") bad.push(`标题与证据不符：${out.title}`);
  if (out.tag !== "图片") bad.push(`分类标记与证据不符：${out.tag}`);

  if (!out.hasPanel) bad.push("页面里没有生成面板");
  /* ⭐ 核心：有表单就给逐字占位；没表单就必须说清为什么 —— 两者必居其一 */
  if (out.hasPrompt) {
    if (out.promptPlaceholder !== "描述你想生成的图片") {
      bad.push(`提示词占位与证据不符：${out.promptPlaceholder}`);
    }
    if (!out.hasRunButton) bad.push("有表单却没有生成按钮");
    if (JSON.stringify(out.sizeModes) !== JSON.stringify(["auto", "ratio", "resolution"])) {
      bad.push(`尺寸模式不对：${JSON.stringify(out.sizeModes)}`);
    }
    if (JSON.stringify(out.tiers) !== JSON.stringify(["1K", "2K", "4K"])) {
      bad.push(`清晰度档不对：${JSON.stringify(out.tiers)}`);
    }
    if (!/\d+x\d+/.test(out.sizeOut ?? "")) bad.push(`没有显示算出来的真实尺寸：${out.sizeOut}`);
    if (!/\d+x\d+/.test(out.sizeOutRatio ?? "")) bad.push(`切到按比例后没给出尺寸：${out.sizeOutRatio}`);
    if (out.sizeOutRatio === out.sizeOut) bad.push("切模式之后尺寸没变（可能没真的重算）");
  } else {
    if (!(out.panelEmptyText ?? "").length) {
      bad.push("没有表单，也没有说明为什么 —— 这就是一个'点了没反应'的死面板");
    }
    if (out.hasRunButton) bad.push("没有表单却摆了个生成按钮");
  }

  if (out.recentTitle !== "最近生成") bad.push(`最近生成那段落标题不对：${out.recentTitle}`);
  if (out.recentEmpty !== "还没有生成过 —— 写一句描述试试") {
    bad.push(`最近生成空态不对：${out.recentEmpty}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 生成图片独立页成立：入口 / 标题逐字 / 要么给表单要么说清为什么 / 尺寸真的在算 / 最近生成空态");
  }
}
