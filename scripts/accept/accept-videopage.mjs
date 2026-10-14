import { chromium } from "playwright";
import fs from "node:fs";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**生成视频独立页**（§174，对应 `chat/create-video`）。
 *
 * ## 这条**不调模型、也不真出视频**（进批跑）
 *
 * 视频这条有个很具体的前提：**这把 Key 下没有视频模型**。
 * 所以这条验的核心是**它诚不诚实**：
 *
 * ① `+` 菜单 → 视频生成 → 页面打开，标题**视频生成**、分类**视频**
 * ② ⭐ **要么给表单、要么说清为什么**：
 *    有模型时占位是证据里那句「描述你想要的视频」；
 *    没模型时那一段必须说明"接口是通的、但这把 Key 下没有模型" ——
 *    **绝不摆一个点了没反应的按钮**
 * ③ 「最近生成」的空态用的是证据里那句（生成的图片和视频会显示在这里）
 * ④ 不点生成 —— 这条验收不动这台机器上的钱和网络
 */
const DATA = "D:/DoubaoWorkClone/.verify/videopage-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });

const PORT = 9326;
const out = {};
let child = null;
let ok = false;
let getLog = () => "";

const boot = async () => {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
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

  /* ① 入口 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(700);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  out.menuHasVideo = await page.evaluate(
    () => document.querySelector('[data-testid="wb-add-pop"]')?.textContent?.includes("视频生成") ?? false,
  );
  await page.locator('[data-testid="wb-add-video"]').click();
  /*
   * ② 等**真条件**，不等固定秒数（§135/§137 的同一条规矩）。
   *
   * ⚠️ 这里原来固定等 1800ms。而面板挂载时会去列视频模型（`video:listModels`），
   * 主进程那边**有 15 秒超时**（`AbortSignal.timeout(15_000)`，超时给诚实的空态）。
   * 上游一慢（实测撞到过），1800ms 时页面还停在「正在列出视频模型…」——
   * 于是这条以"没说明没有模型"的形式**报假案**（产品其实没问题：它只是在等上游）。
   *
   * 现在等的结果是"**两种诚实状态之一出现了**"：要么给表单（有模型），
   * 要么给「没有可用的视频模型」（没模型 / 上游超时）。上限 20 秒（比主进程的 15 秒宽裕）。
   */
  for (let i = 0; i < 40; i += 1) {
    const settled = await page.evaluate(
      () =>
        Boolean(document.querySelector('[data-testid="video-prompt"]')) ||
        Boolean(document.querySelector('[data-testid="video-unavailable"]')),
    );
    if (settled) break;
    await page.waitForTimeout(500);
  }

  out.opened = (await page.locator('[data-testid="wb-videopage"]').count()) > 0;
  out.title = await page.evaluate(() => document.querySelector(".wb-imagepage-head h2")?.textContent?.trim() ?? "");
  out.tag = await page.evaluate(() => document.querySelector(".wb-imagepage-tag")?.textContent?.trim() ?? "");

  /* ② 诚实状态 */
  out.hasPanel = (await page.locator('[data-testid="gen-panel-video"]').count()) > 0;
  out.hasForm = (await page.locator('[data-testid="video-prompt"]').count()) > 0;
  out.formPlaceholder = await page.evaluate(
    () => document.querySelector('[data-testid="video-prompt"]')?.getAttribute("placeholder") ?? "",
  );
  out.unavailableText = await page.evaluate(
    () => document.querySelector('[data-testid="video-unavailable"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
  out.panelEmptyText = await page.evaluate(
    () => document.querySelector(".gen-panel-empty")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
  out.hasGenerateButton = (await page.locator('[data-testid="video-generate"]').count()) > 0;

  /* ③ 最近生成空态 */
  out.recentTitle = await page.evaluate(
    () => document.querySelector('[data-testid="wb-videogen-recent"] h3')?.textContent?.trim() ?? "",
  );
  out.recentEmpty = await page.evaluate(
    () => document.querySelector('[data-testid="wb-videogen-empty"]')?.textContent?.trim() ?? "",
  );
  out.shot = await shot(page, "videopage.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.menuHasVideo) bad.push("+ 菜单里没有「视频生成」");
  if (!out.opened) bad.push("点入口没进视频生成页");
  if (out.title !== "视频生成") bad.push(`标题与证据不符：${out.title}`);
  if (out.tag !== "视频") bad.push(`分类标记与证据不符：${out.tag}`);
  if (!out.hasPanel) bad.push("页面里没有生成面板");

  /* ⭐ 核心：要么给表单、要么说清为什么 */
  if (out.hasForm) {
    if (out.formPlaceholder !== "描述你想要的视频") {
      bad.push(`提示词占位与证据不符：${out.formPlaceholder}`);
    }
    if (!out.hasGenerateButton) bad.push("有表单却没有生成按钮");
  } else {
    const said = out.unavailableText || out.panelEmptyText;
    if (!said) {
      bad.push("⭐ 没有表单，也没有说明为什么 —— 这就是一个'点了没反应'的死面板");
    } else {
      /* 说清了两件事：接口是通的 + 这把 Key 下没有模型 */
      if (!/没有可用的视频模型/.test(said)) bad.push(`没说明"没有模型"：${said}`);
      if (!/接口是通的|POST \/v1\/videos/.test(said)) bad.push(`没说明接口本身是通的：${said}`);
    }
    if (out.hasGenerateButton) bad.push("没有表单却摆了个生成按钮");
  }

  if (out.recentTitle !== "最近生成") bad.push(`最近生成那段落标题不对：${out.recentTitle}`);
  if (out.recentEmpty !== "生成的图片和视频会显示在这里") {
    bad.push(`最近生成空态与证据不符：${out.recentEmpty}`);
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 视频生成独立页成立：入口 / 标题逐字 / 诚实状态（要么给表单、要么说清没模型）/ 最近生成空态逐字");
  }
}
