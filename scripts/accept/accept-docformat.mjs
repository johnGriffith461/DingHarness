import { chromium } from "playwright";
import { NO_PAGE_HINT, bootApp, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**文档的调整语气 / 调整格式**（§168，对应 `aiDoc_keyboard_actionBar_*`）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 因为**格式那半边是纯本地变换**（给小标题加 `##` 这种事不需要模型）——
 * 于是它可以被确定性地验；语气那半边只验**菜单与选项文案逐字**（点它会真调模型）。
 *
 * 五条断言：
 * ① 两个菜单的标题逐字：**调整语气** / **调整格式**
 * ② 语气五个档逐字：更学术 / 更口语化 / 更有文采 / 更专业 / 更有网感
 * ③ 格式四个档逐字：标题 / 小标题 / 副标题 / 正文
 * ④ ⭐ 点「小标题」→ 正文那几行**真的被加上 `##`**
 * ⑤ ⭐ 点「正文」→ 标记被去掉；且每次都留了历史版本（由来写着「小标题」/「正文」）
 */
const DATA = "D:/DoubaoWorkClone/.verify/docformat-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9319;
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

const body = (page) => page.locator('[data-testid="wb-doc-body"]');

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  /* 打开一个文档并写点东西 */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-add-doc"]').click();
  await page.waitForTimeout(1200);
  await body(page).fill("季度复盘\n本季度完成三件事\n继续保持");
  await page.waitForTimeout(800);

  /* ── ① 两个菜单的标题 ── */
  out.toneLabel = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-tone"]')?.textContent?.trim() ?? "",
  );
  out.toolsLabel = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-tools"]')?.textContent?.trim() ?? "",
  );

  /* ── ② 语气五档 ── */
  await page.locator('[data-testid="wb-doc-tone"]').click();
  await page.waitForTimeout(400);
  out.toneItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-doc-tone-"] .wb-doc-pop-item, .wb-doc-pop-item'))
      .map((e) => (e.textContent ?? "").trim())
      .filter(Boolean),
  );
  out.toneItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-doc-tone-pop"] .wb-doc-pop-item')).map((e) =>
      (e.textContent ?? "").trim(),
    ),
  );
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="wb-doc-tone"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-doc-body"]').click();
  await page.waitForTimeout(200);

  /* ── ③ 格式四档 ── */
  await page.locator('[data-testid="wb-doc-tools"]').click();
  await page.waitForTimeout(400);
  out.toolItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-doc-tools-pop"] .wb-doc-pop-item')).map((e) =>
      (e.textContent ?? "").trim(),
    ),
  );

  /*
   * ⚠️ 这两个菜单是**开关式**的（点同一个按钮第二次就是关）。
   * 上面读完文案时它是开着的 —— 所以这里先关掉，后面才谈得上"再打开"。
   * （第一版没关就去点开关，反而把它关上了，然后找不到菜单项。）
   */
  await page.locator('[data-testid="wb-doc-tools"]').click();
  await page.waitForTimeout(300);

  /* ── ④ 全选 → 设为「小标题」── */
  await page.locator('[data-testid="wb-doc-body"]').click();
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-doc-tools"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-doc-tools-h2"]').click();
  await page.waitForTimeout(800);
  out.afterH2 = await body(page).inputValue();

  /* ── ⑤ 设为「正文」→ 标记去掉 ── */
  await page.locator('[data-testid="wb-doc-body"]').click();
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-doc-tools"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-doc-tools-text"]').click();
  await page.waitForTimeout(800);
  out.afterText = await body(page).inputValue();

  /* 历史里应该留着两次由来 */
  await page.locator('[data-testid="wb-doc-history-btn"]').click();
  await page.waitForTimeout(400);
  out.reasons = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-doc-version-reason")).map((e) => (e.textContent ?? "").trim()),
  );
  out.note = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-note"]')?.textContent?.trim() ?? "",
  );
  out.shot = await shot(page, "docformat.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (out.toneLabel !== "调整语气") bad.push(`语气菜单的标题不对：${out.toneLabel}`);
  if (out.toolsLabel !== "调整格式") bad.push(`格式菜单的标题不对：${out.toolsLabel}`);

  const wantTones = ["更学术", "更口语化", "更有文采", "更专业", "更有网感"];
  if (JSON.stringify(out.toneItems) !== JSON.stringify(wantTones)) {
    bad.push(`语气五档与证据不符：${JSON.stringify(out.toneItems)}`);
  }
  const wantTools = ["标题", "小标题", "副标题", "正文"];
  if (JSON.stringify(out.toolItems) !== JSON.stringify(wantTools)) {
    bad.push(`格式四档与证据不符：${JSON.stringify(out.toolItems)}`);
  }

  /* ④ 真的加上了标记 */
  const h2 = out.afterH2 ?? "";
  if (!h2.includes("## 季度复盘")) bad.push(`设为小标题后正文不对：${JSON.stringify(h2)}`);
  if (!h2.includes("## 本季度完成三件事")) bad.push("三行没有全部变成小标题");
  /* ⑤ 标记真的去掉了 */
  const txt = out.afterText ?? "";
  if (txt.includes("##")) bad.push(`设为正文后标记还在：${JSON.stringify(txt)}`);
  if (!txt.includes("季度复盘")) bad.push("设为正文把内容弄丢了");

  /* 留痕 */
  if (!(out.reasons ?? []).includes("小标题")) bad.push(`历史里没有「小标题」这一版：${JSON.stringify(out.reasons)}`);
  if (!(out.reasons ?? []).includes("正文")) bad.push(`历史里没有「正文」这一版：${JSON.stringify(out.reasons)}`);

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 文档的调整语气/格式成立：两个菜单与九档文案逐字 / 设为小标题真的加 ## / 设为正文真的去掉 / 都留了由来");
  }
}
