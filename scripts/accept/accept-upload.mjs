import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**上传按文件回报结果 + 上传状态面板**（§170，对应 `drive_upload_*`）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * ## 为什么这样验（说清边界）
 *
 * 「上传」按钮弹的是**系统文件选择框** —— 自动化点不了它。
 * 所以这条验的是**能被确定性地验**的那部分，并且**明说我漏了什么**：
 *
 * ① ⭐ `drive:importPaths`（对话框那条路**共用同一段实现**）：
 *    正常文件 → `ok:true` 且**真的落进 drive/**；`.exe` → `ok:false` + `formatUnsupported`
 * ② ⭐ **单个文件被拒不会让整批失败**（同一个结果里一个成功一个失败）
 * ③ 新文件**出现在云盘列表里**
 * ④ 空闲时**没有**上传面板（没任务不该占地方）；面板文案由 19 条单测覆盖
 *
 * ⚠️ **没验**：点「上传」→ 系统框 → 面板逐条亮起。框点不了，
 * 所以"面板的可见性与逐条状态"这半边靠 `upload.test.ts`（19 条）+ 结构断言。
 */
const DATA = "D:/DoubaoWorkClone/.verify/upload-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
fs.mkdirSync(path.join(DATA, "drive"), { recursive: true });

/** 待导入的两个源文件（放在数据目录外的一个临时位置）。 */
const SRC = path.join(DATA, "待导入");
fs.mkdirSync(SRC, { recursive: true });
const GOOD = path.join(SRC, "周报.md");
const BAD = path.join(SRC, "某个程序.exe");
fs.writeFileSync(GOOD, "# 本周\n\n完成上传面板。\n", "utf8");
fs.writeFileSync(BAD, "MZ...", "utf8");

const PORT = 9322;
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

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-cloud"]').click();
  await page.waitForTimeout(2000);

  /* ④ 空闲时没有面板 */
  out.panelWhenIdle = await page.locator('[data-testid="wb-upload-panel"]').count();
  out.hasUploadButton = (await page.locator('[data-testid="wb-cloud-upload"]').count()) > 0;

  /* ①② 走程序化入口（与对话框入口共用实现） */
  out.result = await page.evaluate(
    async ([good, bad]) => {
      const shell = window.shell;
      if (!shell?.drive?.importPaths) return { error: "桥不可用" };
      return await shell.drive.importPaths([good, bad]);
    },
    [GOOD, BAD],
  );

  /* ③ 云盘列表里应该出现新文件 */
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.locator('[data-testid="wb-nav-cloud"]').click();
  await page.waitForTimeout(2200);
  out.rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-file-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("wb-file-", ""),
    ),
  );
  out.diskFiles = fs.readdirSync(path.join(DATA, "drive")).sort();
  out.shot = await shot(page, "upload.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (out.panelWhenIdle !== 0) bad.push("空闲时上传面板竟然显示着（没任务不该占地方）");
  if (!out.hasUploadButton) bad.push("云盘页没有「上传」按钮");

  const r = out.result ?? {};
  if (r.error) bad.push(r.error);
  if (r.imported !== 1) bad.push(`应该只成功 1 个，实际 ${r.imported}`);
  const items = r.items ?? [];
  if (items.length !== 2) bad.push(`应该按文件回报 2 条，实际 ${items.length}`);
  const good = items.find((x) => x.name === "周报.md");
  const badItem = items.find((x) => x.name === "某个程序.exe");
  if (!good?.ok) bad.push(`正常文件没进来：${JSON.stringify(good)}`);
  if (!good?.savedAs) bad.push("成功那条没给落盘后的文件名");
  if (badItem?.ok) bad.push("⭐ .exe 竟然被收进来了");
  if (badItem?.reason !== "formatUnsupported") {
    bad.push(`.exe 的失败原因不对（应为 formatUnsupported）：${badItem?.reason}`);
  }

  /* ③ 真的落盘 + 列表里看得见 */
  if (!(out.diskFiles ?? []).includes("周报.md")) bad.push(`磁盘上没落盘：${JSON.stringify(out.diskFiles)}`);
  if ((out.diskFiles ?? []).includes("某个程序.exe")) bad.push("⭐ .exe 竟然真的被复制进了云盘目录");
  if (!(out.rows ?? []).includes("周报.md")) bad.push("云盘列表里没看到新导入的文件");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 上传按文件回报成立：正常文件真落盘 / .exe 因类型被拒且原因逐字 / 一个被拒不影响整批 / 空闲无面板");
  }
}
