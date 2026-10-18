import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, pickPort, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**诊断包先预览、再导出**（G17）。
 *
 * ## 判据（全部是行为）
 *
 * 1. 命令面板输入「诊断」→ 打开预览（**没有**自动写盘）；
 * 2. 预览里能看到 `kind: ding-diagnostics` 与 doctor 检查项；
 * 3. 预览文本里**没有**密钥值（环境里放一把假 key，断言它不出现）；
 * 4. 点「导出」之后 `diagnostics/` 下才有文件，且内容与预览一致；
 * 5. Esc 关闭 → 焦点回位。
 */
const DATA = ".verify/diagnostics-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}

const SECRET = "sk-diag-SECRET-987654";
const keysFile = path.join(DATA, "keys.yaml");
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(keysFile, `refs:\n  DEEPSEEK_API_KEY: ${SECRET}\n`, "utf8");

const out = {};
const booted = await bootApp({
  port: await pickPort([9401]),
  dataDir: DATA,
  timeoutMs: 30000,
  extraEnv: { DSH_CREDENTIALS_FILE: keysFile, DEEPSEEK_API_KEY: SECRET },
});
const { child, ok, getLog } = booted;
const diagDir = path.join(DATA, "diagnostics");
const diagFiles = () => (fs.existsSync(diagDir) ? fs.readdirSync(diagDir) : []);

try {
  if (!ok) throw new Error("应用没起来：" + (getLog() || "").slice(-600));
  const b = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  /* ① 命令面板打开预览 */
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(400);
  await page.keyboard.type("诊断");
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  out.opened = (await page.locator('[data-testid="wb-diagnostics"]').count()) > 0;

  /* 等预览文本出现 */
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (await page.locator('[data-testid="wb-diagnostics-json"]').count()) === 0) {
    await page.waitForTimeout(400);
  }
  out.hasPreview = (await page.locator('[data-testid="wb-diagnostics-json"]').count()) > 0;
  const previewText = (await page.locator('[data-testid="wb-diagnostics-json"]').textContent()) ?? "";
  out.previewHasKind = previewText.includes("ding-diagnostics");
  out.previewHasDoctor = previewText.includes("checks") || previewText.includes("模型凭据");
  out.previewLeaksSecret = previewText.includes(SECRET);
  out.filesBeforeExport = diagFiles();

  out.shot = await shot(page, "diagnostics-preview.png");

  /* ④ 点导出 */
  if (out.hasPreview) {
    await page.locator('[data-testid="wb-diagnostics-export"]').click();
    for (let i = 0; i < 40 && diagFiles().length === 0; i += 1) await page.waitForTimeout(250);
  }
  out.filesAfterExport = diagFiles();
  if (out.filesAfterExport.length) {
    const file = path.join(diagDir, out.filesAfterExport[0]);
    const written = fs.readFileSync(file, "utf8");
    /*
     * 预览与导出各自组装一次，`at`（时间戳）必然不同 —— 比结构，不比时间。
     * 其余字段必须一模一样：那才叫「看到的就是导出的」。
     */
    const strip = (text) => {
      const obj = JSON.parse(text);
      delete obj.at;
      return JSON.stringify(obj);
    };
    try {
      out.exportedMatchesPreview = strip(written) === strip(previewText);
    } catch {
      out.exportedMatchesPreview = false;
    }
    out.exportedLeaksSecret = written.includes(SECRET);
  }

  /* ⑤ Esc 关闭 + 焦点归位 */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  out.closed = (await page.locator('[data-testid="wb-diagnostics"]').count()) === 0;
  out.focusAfterClose = await page.evaluate(() => {
    const el = document.activeElement;
    return el === document.body ? "body" : el?.getAttribute("data-testid") || el?.tagName || "";
  });
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  await killTree(child);
  console.log(JSON.stringify(out, null, 2));
  const bad = [];
  if (!out.opened) bad.push("命令面板没能打开诊断预览");
  if (!out.hasPreview) bad.push("预览文本没出现");
  if (!out.previewHasKind) bad.push("预览里没有 ding-diagnostics 标记（不是真包）");
  if (!out.previewHasDoctor) bad.push("预览里看不到自检项");
  if (out.previewLeaksSecret) bad.push("⭐ 预览里出现了密钥值");
  if ((out.filesBeforeExport ?? []).length) bad.push("还没点导出，诊断包就已经写盘了（预览应该不写盘）");
  if (!(out.filesAfterExport ?? []).length) bad.push("点了导出却没有文件");
  if (out.exportedMatchesPreview === false) bad.push("导出的内容与预览不一致（不是同一份）");
  if (out.exportedLeaksSecret) bad.push("⭐ 导出的诊断包里出现了密钥值");
  if (!out.closed) bad.push("Esc 没关掉预览");
  if (out.focusAfterClose === "body") bad.push("关闭后焦点掉在 body");
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 诊断包先预览（不含密钥、未写盘）→ 确认后导出，内容与预览一致");
  }
}
