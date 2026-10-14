import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**文档的「粘贴」与「插入附件」**（§173，`aiDoc_actionBar_paste` /
 * `aiDoc_keyboard_actionBar_files`）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 六条断言：
 * ① 两个按钮的文案逐字：**粘贴** / **插入附件**
 * ② ⭐ 往剪贴板里写一段字 → 点「粘贴」→ **真的插到了选区处**（替换选区）
 * ③ ⭐ 插完留痕写着「粘贴」
 * ④ ⭐ 点「插入附件」列的是**云盘里的文件**（不弹系统框）
 * ⑤ ⭐ 选中一个 → 插进来的是一条 `dshasset://file/<origin>/<名字>` 链接，**且与那个文件对得上**
 * ⑥ 剪贴板空的时候**有话直说**（不是点了没反应）
 */
const DATA = ".verify/docbar-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(path.join(DATA, "drive"), { recursive: true });
/** 云盘里放一个文件 —— 「插入附件」要挑的对象。 */
fs.writeFileSync(path.join(DATA, "drive", "季度数据.md"), "# 数据\n", "utf8");

const PORT = 9325;
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
const note = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="wb-doc-note"]')?.textContent?.trim() ?? "");

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

  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-composer-add"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-add-doc"]').click();
  await page.waitForTimeout(1200);
  await body(page).fill("开头ABC结尾");
  await page.waitForTimeout(900);

  /* ① 两个按钮 */
  out.pasteLabel = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-paste"]')?.textContent?.trim() ?? "",
  );
  out.attachLabel = await page.evaluate(
    () => document.querySelector('[data-testid="wb-doc-attach"]')?.textContent?.trim() ?? "",
  );

  /** 通过桥写剪贴板（主进程那条通道，与「粘贴」读的是同一个）。 */
  const setClip = (text) =>
    page.evaluate(async (t) => {
      const shell = window.shell;
      return await shell.clipboard.write(t);
    }, text);

  /*
   * ② 选一段再粘贴 → 那段应当被**替换**掉
   *
   * ⚠️ 不能用 `setSelectionRange` + 派一个 `select` 事件来造假选区：
   * React 的 `onSelect` 不认它（第一版就是这么误判的，粘贴于是插到了末尾）。
   * 这里用**真键盘手势**：光标移到末尾，再按住 Shift 往左选两个字符（"结尾"）。
   */
  await setClip("XYZ");
  await page.locator('[data-testid="wb-doc-body"]').click();
  await page.keyboard.press("End");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-doc-paste"]').click();
  await page.waitForTimeout(900);
  out.afterPaste = await body(page).inputValue();
  out.noteAfterPaste = await note(page);

  /* 称③留痕 */
  await page.locator('[data-testid="wb-doc-history-btn"]').click();
  await page.waitForTimeout(400);
  out.reasons = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".wb-doc-version-reason")).map((e) => (e.textContent ?? "").trim()),
  );
  await page.locator('[data-testid="wb-doc-history-btn"]').click();
  await page.waitForTimeout(300);

  /* ④⑤ 插入附件 */
  await page.locator('[data-testid="wb-doc-attach"]').click();
  await page.waitForTimeout(900);
  out.attachItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-doc-attach-pop"] .wb-doc-pop-item')).map((e) =>
      (e.textContent ?? "").trim(),
    ),
  );
  if ((out.attachItems ?? []).includes("季度数据.md")) {
    await page.locator('[data-testid="wb-doc-attach-季度数据.md"]').click();
    await page.waitForTimeout(900);
  }
  out.afterAttach = await body(page).inputValue();
  out.noteAfterAttach = await note(page);

  /* ⑥ 剪贴板空时说一句 */
  await setClip("");
  await page.locator('[data-testid="wb-doc-paste"]').click();
  await page.waitForTimeout(700);
  out.noteEmpty = await note(page);
  out.afterEmptyPaste = await body(page).inputValue();

  out.shot = await shot(page, "docbar.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ① */
  if (out.pasteLabel !== "粘贴") bad.push(`「粘贴」文案不对：${out.pasteLabel}`);
  if (out.attachLabel !== "插入附件") bad.push(`「插入附件」文案不对：${out.attachLabel}`);

  /* ② 替换选区 */
  if (out.afterPaste !== "开头ABCXYZ") bad.push(`粘贴没有替换选区：${JSON.stringify(out.afterPaste)}`);
  /* ③ 留痕 */
  if (!(out.reasons ?? []).includes("粘贴")) bad.push(`留痕里没有「粘贴」：${JSON.stringify(out.reasons)}`);

  /* ④⑤ 附件 */
  if (!(out.attachItems ?? []).includes("季度数据.md")) {
    bad.push(`「插入附件」没列出云盘里的文件：${JSON.stringify(out.attachItems)}`);
  }
  const link = "[季度数据.md](dshasset://file/drive/%E5%AD%A3%E5%BA%A6%E6%95%B0%E6%8D%AE.md)";
  if (!(out.afterAttach ?? "").includes(link)) {
    bad.push(`插入的链接不对：${JSON.stringify(out.afterAttach)}`);
  }
  if ((out.noteAfterAttach ?? "").trim() !== "已插入附件") bad.push(`附件那句不对：${out.noteAfterAttach}`);

  /* ⑥ 空剪贴板有话说 */
  if (out.noteEmpty !== "剪贴板里没有文字") bad.push(`剪贴板空时没说清：${out.noteEmpty}`);
  if (out.afterEmptyPaste !== out.afterAttach) bad.push("剪贴板是空的却动了正文");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 粘贴与插入附件成立：逐字 / 粘贴替换选区且留痕 / 附件列云盘文件且链接对得上 / 空剪贴板有话直说");
  }
}
