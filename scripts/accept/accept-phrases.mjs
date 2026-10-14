import { chromium } from "playwright";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**`@` 常用语**（§161，对应 `coding_chat_mode_new_placeholder`）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 七条断言：
 * ① 敲 `@` 唤出选单（分组在）
 * ② `@bug` 筛到那一条；`@zzz` → **没有匹配的常用语**
 * ③ 点一条 → 正文替换成常用语正文，**`@` 与查询词都不留**
 * ④ ⭐ **光标落在插入内容的末尾**（用户接着就能写/粘代码）
 * ⑤ ⭐ **句中的 `@` 不触发**（`a@b.com` 一敲就弹选单最烦人）
 * ⑥ Esc 收起（`@` 还在，不吞字）
 * ⑦ 选单开着时按 Enter **是选第一条，不是把消息发出去**
 */
const DATA = "D:/DoubaoWorkClone/.verify/phrases-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9312;
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

const input = (page) => page.locator('[data-testid="wb-composer-input"]');
const menuOpen = async (page) => (await page.locator('[data-testid="wb-phrase-menu"]').count()) > 0;

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

  /* ── ① 敲 @ 唤出 ── */
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);
  await input(page).click();
  await input(page).type("@");
  await page.waitForTimeout(500);
  out.menuShown = await menuOpen(page);
  out.groups = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-phrase-group")).map((e) => (e.textContent ?? "").trim()),
  );
  out.itemCount = await page.locator(".wb-phrase-item").count();

  /* ── ② 筛选 ── */
  await input(page).fill("@bug");
  await page.waitForTimeout(400);
  out.bugItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-phrase-item")).map((e) => (e.textContent ?? "").trim()),
  );
  await input(page).fill("@zzz");
  await page.waitForTimeout(400);
  out.emptyText = await page.evaluate(
    () => document.querySelector('[data-testid="wb-phrase-empty"]')?.textContent?.trim() ?? "",
  );

  /* ── ③④ 点一条，验替换与光标 ── */
  await input(page).fill("帮我看看 @bug");
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-phrase-find-bug"]').click();
  await page.waitForTimeout(500);
  out.afterPick = await input(page).inputValue();
  out.caretAtEnd = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-composer-input"]');
    return el ? el.selectionStart === el.value.length : false;
  });
  out.menuGoneAfterPick = !(await menuOpen(page));

  /* ── ⑤ 句中的 @ 不触发（最重要的一条守卫）── */
  await input(page).fill("");
  await page.waitForTimeout(200);
  await input(page).click();
  await input(page).type("a@b.com");
  await page.waitForTimeout(500);
  out.emailNoMenu = !(await menuOpen(page));

  /* ── ⑥ Esc 收起 ── */
  await input(page).fill("@解释");
  await page.waitForTimeout(400);
  out.menuBeforeEsc = await menuOpen(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  out.menuAfterEsc = await menuOpen(page);
  out.textAfterEsc = await input(page).inputValue();

  /* ── ⑦ 选单开着时 Enter 是"选第一条"，不是发送 ── */
  /*
   * ⚠️ 先清空再输入：上一步按过 Esc，正文还是 `@解释` 没变，
   * 而**把同样的值 fill 一遍 React 不会触发 onChange**（值没变就不算改动）——
   * 于是菜单根本不会再开，Enter 自然就把消息发出去了。
   * 这是"脚本的错觉"，不是产品问题：真人按完 Esc 再打字必然触发 change。
   */
  await input(page).fill("");
  await page.waitForTimeout(200);
  await input(page).click();
  await input(page).type("@解释");
  await page.waitForTimeout(400);
  out.menuBeforeEnter = await menuOpen(page);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  out.afterEnter = await input(page).inputValue();
  out.sentInstead = out.afterEnter.trim() === ""; // 发送会把输入框清空
  out.shot = await shot(page, "phrases.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ① 唤出 */
  if (!out.menuShown) bad.push("敲 @ 没唤出常用语选单");
  if ((out.groups ?? []).length === 0) bad.push("选单里没有分组");
  if (!((out.itemCount ?? 0) > 0)) bad.push("选单里没有词条");

  /* ② 筛选 */
  if (JSON.stringify(out.bugItems) !== JSON.stringify(["找出潜在 bug"])) {
    bad.push(`@bug 筛选结果不对：${JSON.stringify(out.bugItems)}`);
  }
  if (out.emptyText !== "没有匹配的常用语") bad.push(`搜不到时的提示不对：${out.emptyText}`);

  /* ③④ 替换与光标 */
  if (!(out.afterPick ?? "").includes("潜在 bug")) bad.push(`选中后正文没换成常用语：${out.afterPick}`);
  if ((out.afterPick ?? "").includes("@")) bad.push("替换后 @ 还留在正文里");
  if ((out.afterPick ?? "").includes("bug\n")) bad.push("查询词没被替换掉");
  if (!(out.afterPick ?? "").startsWith("帮我看看 ")) bad.push("前面的内容没保住");
  if (!out.caretAtEnd) bad.push("光标没落在插入内容的末尾");
  if (!out.menuGoneAfterPick) bad.push("选中之后选单没关掉");

  /* ⑤ 邮箱 */
  if (!out.emailNoMenu) bad.push("⭐ 句中的 @ 也弹了选单（邮箱会误触发）");

  /* ⑥ Esc */
  if (!out.menuBeforeEsc) bad.push("Esc 之前选单就不在（前置条件不成立）");
  if (out.menuAfterEsc) bad.push("Esc 没有收起选单");
  if (out.textAfterEsc !== "@解释") bad.push(`Esc 把正文改了：${out.textAfterEsc}`);

  /* ⑦ Enter */
  if (!out.menuBeforeEnter) bad.push("Enter 之前选单不在（前置条件不成立）");
  if (out.sentInstead) bad.push("⭐ 选单开着时按 Enter 把消息发出去了（应该只是选第一条）");
  if (!(out.afterEnter ?? "").includes("解释")) bad.push(`Enter 没选上第一条：${out.afterEnter}`);

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ @ 常用语成立：唤出 / 筛选 / 替换（含光标）/ 邮箱不误触发 / Esc 收起 / Enter 选而不发");
  }
}
