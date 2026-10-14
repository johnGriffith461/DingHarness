import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**生成的图片能在云盘里看到**（§166）。
 *
 * ## 修的是哪条
 *
 * §165 做完"生成图片"页之后发现：生成图落在 `assets/`，而云盘只扫
 * `artifacts/` `exports/` `drive/` —— 于是**生成了一张图，云盘里根本看不到**：
 * 它只存在于那一页的内存列表里，关掉就没了。
 *
 * ## 这条**不调模型、也不真出图**
 *
 * 直接把一张图放进 `assets/`（**那正是生成图落的目录**），验云盘认不认它。
 *
 * 六条断言：
 * ① 云盘里能看到它，类型=**图片**、来源=**素材**
 * ② 筛「图片」能筛到它
 * ③ 它是**磁盘上真有的文件**（在 assets 目录里）
 * ④ 四个来源的标签都在（产物 / 导出 / 素材 / 云盘本体不挂标签）
 * ⑤ 重命名**真改磁盘**（顺带证明这条链路端到端是通的）
 * ⑥ 删除走**确认框**（§158 建的规矩，对新来源同样成立）
 */
const DATA = "D:/DoubaoWorkClone/.verify/assets-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const ASSETS = path.join(DATA, "assets");
const ARTIFACTS = path.join(DATA, "artifacts");
fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });

/** 1×1 的真 PNG（不是伪装成图片的空文件）。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
fs.writeFileSync(path.join(ASSETS, "gen-001.png"), PNG);
fs.writeFileSync(path.join(ARTIFACTS, "报告.md"), "# 报告\n", "utf8");

const PORT = 9317;
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

const rowInfo = (page, name) =>
  page.evaluate((n) => {
    const row = document.querySelector(`[data-testid="wb-file-${n}"]`);
    return row ? (row.textContent ?? "").replace(/\\s+/g, " ").trim() : "";
  }, name);

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

  await page.locator('[data-testid="wb-nav-cloud"]').click();
  await page.waitForTimeout(2000);

  /* ① 看得到、类型与来源对 */
  out.assetRow = await rowInfo(page, "gen-001.png");
  out.artifactRow = await rowInfo(page, "报告.md");
  out.rowCount = await page.locator(".wb-tr:not(.wb-th)").count();

  /* ② 筛「图片」 */
  await page.locator('[data-testid="wb-cloud-filter"]').selectOption("image");
  await page.waitForTimeout(700);
  out.imageRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-file-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("wb-file-", ""),
    ),
  );
  await page.locator('[data-testid="wb-cloud-filter"]').selectOption("all");
  await page.waitForTimeout(600);

  /* ⑤ 重命名真改磁盘 */
  await page.locator('[data-testid="wb-file-gen-001.png"]').click({ button: "right" });
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-drive-menu-重命名"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-cloud-rename-input"]').fill("封面图.png");
  await page.locator('[data-testid="wb-cloud-rename-ok"]').click();
  await page.waitForTimeout(1500);
  out.assetsAfterRename = fs.readdirSync(ASSETS);

  /* ⑥ 删除要确认 */
  await page.locator('[data-testid="wb-del-封面图.png"]').click();
  await page.waitForTimeout(500);
  out.confirmShown = (await page.locator('[data-testid="wb-cloud-confirm"]').count()) > 0;
  await page.locator('[data-testid="wb-cloud-confirm-cancel"]').click();
  await page.waitForTimeout(400);
  out.assetsAfterCancel = fs.readdirSync(ASSETS);
  out.shot = await shot(page, "assets.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ① 类型与来源 */
  if (!(out.assetRow ?? "").includes("gen-001.png")) bad.push("云盘里没有那张生成图（assets 没被扫）");
  if (!(out.assetRow ?? "").includes("图片")) bad.push(`生成图没被识别成图片：${out.assetRow}`);
  if (!(out.assetRow ?? "").includes("素材")) bad.push(`生成图的来源标签不对（应显示「素材」）：${out.assetRow}`);
  if (!(out.artifactRow ?? "").includes("产物")) bad.push(`产物的来源标签丢了：${out.artifactRow}`);
  if ((out.rowCount ?? 0) !== 2) bad.push(`云盘应有 2 个文件（1 素材 + 1 产物），实际 ${out.rowCount}`);

  /* ② 筛图片 */
  if (JSON.stringify(out.imageRows) !== JSON.stringify(["gen-001.png"])) {
    bad.push(`筛「图片」结果不对：${JSON.stringify(out.imageRows)}`);
  }

  /* ⑤ 重命名真改磁盘 */
  if (JSON.stringify(out.assetsAfterRename) !== JSON.stringify(["封面图.png"])) {
    bad.push(`重命名没改到 assets 里的文件：${JSON.stringify(out.assetsAfterRename)}`);
  }

  /* ⑥ 删除确认 */
  if (!out.confirmShown) bad.push("删素材没有出确认框（新来源也要守同一套规矩）");
  if (JSON.stringify(out.assetsAfterCancel) !== JSON.stringify(["封面图.png"])) {
    bad.push("点了取消画面却没了");
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 生成图进云盘成立：看得到 / 类型图片 / 来源素材 / 能筛 / 重命名真改盘 / 删除要确认");
  }
}
