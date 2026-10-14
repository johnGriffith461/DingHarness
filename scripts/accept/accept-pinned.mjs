import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, readStoreFile, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**新对话默认模型**（§183，`settings_defaultNewChatModel`）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 判据是"**它真的接在了通道解析上**"，所以除了"值能存住"，还要看：
 * ① 通用页有选择器，第一项是「**记忆上次**」（`settings_modelSelection_useLast`）
 * ② 选中一个模型 → **落盘** `settings.json` 且形状是 `provider/model`
 * ③ ⭐ 重启之后选择还在（列表那行也显示它）
 * ④ ⭐ 生效判据：`resolveChatRoute({ fresh: true })` 在页面里真的会取到钉的那个
 *    （用 `__DSH_TEST__` 之外的公开路径拿不到，所以这条由 7 条 `pickRoute` 单测守着；
 *     这里只断言"设置真的接进了渲染侧内存"，即列表那行的文案跟着变）
 */
const DATA = "D:/DoubaoWorkClone/.verify/pinned-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const PORT = 9335;
const out = {};
let child = null;

const boot = async () => bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });

const openSettings = async (page) => {
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(900);
};

const readSettingsFile = () => {
  const f = path.join(DATA, "settings.json");
  return fs.existsSync(f) ? readStoreFile(f) : null;
};

try {
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

  await openSettings(page);
  await page.locator('[data-testid="wb-set-通用"]').click();
  await page.waitForTimeout(1200);

  /* ① 选择器与第一项 */
  out.hasSelect = (await page.locator('[data-testid="wb-setpage-pinned"]').count()) > 0;
  out.options = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-setpage-pinned"] option')).map((e) => ({
      value: e.value,
      text: (e.textContent ?? "").trim(),
    })),
  );
  out.firstOption = out.options?.[0];
  out.valueBefore = await page.evaluate(
    () => document.querySelector('[data-testid="wb-setpage-pinned"]')?.value ?? "",
  );

  /* ② 选一个真模型（有的话） */
  const real = (out.options ?? []).find((o) => o.value);
  if (real) {
    await page.locator('[data-testid="wb-setpage-pinned"]').selectOption(real.value);
    await page.waitForTimeout(1000);
    out.picked = real.value;
    out.fileAfterPick = readSettingsFile();
  }

  out.shot = await shot(page, "pinned.png");
  await b1.close();
  await killTree(first.child);
  child = null;

  /* ③ 重启 */
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
  await openSettings(page2);
  out.generalRow = await page2.evaluate(
    () => document.querySelector('[data-testid="wb-set-通用"]')?.textContent?.trim() ?? "",
  );
  await page2.locator('[data-testid="wb-set-通用"]').click();
  await page2.waitForTimeout(1200);
  out.valueAfterRestart = await page2.evaluate(
    () => document.querySelector('[data-testid="wb-setpage-pinned"]')?.value ?? "",
  );
  await b2.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.hasSelect) bad.push("通用页没有「新对话默认模型」选择器");
  if (out.firstOption?.value !== "" || out.firstOption?.text !== "记忆上次") {
    bad.push(`第一项应当是「记忆上次」：${JSON.stringify(out.firstOption)}`);
  }
  if ((out.options ?? []).length < 1) bad.push("选择器一个选项都没有");

  if (out.picked) {
    /* ② 落盘且形状对 */
    if (out.fileAfterPick?.pinnedModel !== out.picked) {
      bad.push(`⭐ 选择没落盘（settings.json = ${JSON.stringify(out.fileAfterPick)}）：选的 ${out.picked}`);
    }
    if (!/^[^/]+\/.+$/.test(out.fileAfterPick?.pinnedModel ?? "")) {
      bad.push(`落盘形状不是 provider/model：${out.fileAfterPick?.pinnedModel}`);
    }
    /* ③ 重启后还在 */
    if (out.valueAfterRestart !== out.picked) {
      bad.push(`⭐ 重启之后选择没了：${out.valueAfterRestart}（应为 ${out.picked}）`);
    }
    if (!(out.generalRow ?? "").includes(out.picked.split("/").pop() ?? "")) {
      bad.push(`列表那行没显示钉住的模型：${out.generalRow}`);
    }
  } else {
    bad.push("环境里没有可选模型（单测覆盖了 pickRoute，但这条验收需要至少一个模型）");
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 新对话默认模型成立：选择器逐字 / 选中后落盘成 provider/model / 重启后仍在且列表行可见");
  }
}
