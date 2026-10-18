import { chromium } from "playwright";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, pickPort, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**只靠键盘走完一段核心路径**（G16）。
 *
 * ## 为什么必须真按键
 *
 * `a11yBasics.test.ts` 只能断"源码里有没有 aria-label"；焦点环、焦点陷阱、
 * "Tab 会不会跑到浮层背后的内容里"这三件事只有真 DOM + 真按键能验。
 *
 * ## 这条断的四件事
 *
 * 1. **Ctrl+K 打开命令面板**（键盘可开），输入「设置」回车 → 设置打开；
 * 2. 设置打开后**焦点在浮层里**（不是留在背后的按钮上）；
 * 3. 连按 40 次 Tab，焦点**始终没跑出** `[data-testid=wb-settings]`；
 * 4. Esc 关闭之后，焦点**还给了打开它的那个元素**（不是掉到 body）。
 *
 * 另外断一条：键盘操作之后 `<html data-kb="1">` 亮起（焦点环按输入模态分档的那套基础）。
 */
const DATA = ".verify/keyboard-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const out = {};
const booted = await bootApp({ port: await pickPort([9391]), dataDir: DATA, timeoutMs: 30000 });
const { child, ok, getLog } = booted;
try {
  if (!ok) throw new Error("应用没起来：" + (getLog() || "").slice(-600));
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  /* ① 键盘打开命令面板（默认 Mod+K = Ctrl+K） */
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(500);
  out.paletteOpen = (await page.locator('[data-testid="wb-palette"]').count()) > 0;

  /* 输入「设置」→ 回车 */
  await page.keyboard.type("设置");
  await page.waitForTimeout(400);
  out.settingsItem = (await page.locator('[data-testid="wb-palette-item-settings"]').count()) > 0;
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  out.settingsOpen = (await page.locator('[data-testid="wb-settings"]').count()) > 0;

  /* ② 焦点在浮层里 */
  out.focusInsideOnOpen = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="wb-settings"]');
    const active = document.activeElement;
    return Boolean(root && active && root.contains(active));
  });

  /* ③ 40 次 Tab 不逃逸 */
  const escapes = [];
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press(i % 7 === 6 ? "Shift+Tab" : "Tab");
    const inside = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="wb-settings"]');
      const active = document.activeElement;
      return Boolean(root && active && root.contains(active));
    });
    if (!inside) escapes.push(i + 1);
  }
  out.tabEscapes = escapes;

  /* 键盘模态属性（焦点环那套按输入模态分档） */
  out.kbMode = await page.evaluate(() => document.documentElement.getAttribute("data-kb"));

  /* ④ Esc 关闭 + 焦点还回去 */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  out.closed = (await page.locator('[data-testid="wb-settings"]').count()) === 0;
  out.focusAfterClose = await page.evaluate(() => {
    /* ⚠️ evaluate 的回调是在页面里执行的**纯 JS**：不能写 TS 断言 */
    const active = document.activeElement;
    return {
      testid: active?.getAttribute("data-testid") ?? "",
      tag: active?.tagName ?? "",
      onBody: active === document.body,
    };
  });

  /* 焦点环本身：键盘 Tab 到一个可见按钮，计算样式里要有 outline 或 box-shadow */
  await page.locator('[data-testid="wb-nav-scheduled"]').focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  out.focusRing = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const s = getComputedStyle(el);
    return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow.slice(0, 60) };
  });

  out.shot = await shot(page, "keyboard-focus.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  await killTree(child);
  console.log(JSON.stringify(out, null, 2));
  const bad = [];
  if (!out.paletteOpen) bad.push("Ctrl+K 没打开命令面板");
  if (!out.settingsItem) bad.push("命令面板里没有「设置」动作（键盘到不了设置）");
  if (!out.settingsOpen) bad.push("回车没打开设置");
  if (!out.focusInsideOnOpen) bad.push("设置打开后焦点不在浮层里（Tab 会跑到背景）");
  if ((out.tabEscapes ?? []).length) bad.push(`Tab 第 ${out.tabEscapes.join(",")} 次跑出了设置浮层`);
  if (out.kbMode !== "1") bad.push(`键盘操作后 data-kb 不是 1（是 ${JSON.stringify(out.kbMode)}）`);
  if (!out.closed) bad.push("Esc 没关掉设置");
  if (out.focusAfterClose?.onBody) bad.push("关闭后焦点掉到了 body（应该还给打开它的元素）");
  if (out.focusRing && out.focusRing.outlineStyle === "none" && out.focusRing.boxShadow === "none") {
    bad.push("键盘聚焦的元素没有可见焦点指示（outline 与 box-shadow 都是 none）");
  }
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 键盘能开设置、Tab 不逃逸、Esc 关闭且焦点归位、焦点环可见");
  }
}
