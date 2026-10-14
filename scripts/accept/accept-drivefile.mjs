import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, freshDir, killTree, shot } from "./harness.mjs";

/**
 * 验收：**云盘的删除确认 / 重命名 / AI 阅读**（§158）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 每一条都去**磁盘上验**，因为这三个动作都是"改文件"：
 * ① 删除：点 `×` 先出确认框（`确认删除文件？`）；**取消 → 文件还在**；确认 → 文件真没了
 * ② 重命名：右键菜单里的「重命名」→ 磁盘上真的换了名字
 * ③ 重命名到**已存在的名字**：被挡住并说清原因，**磁盘没变**（不覆盖）
 * ④ 右键菜单里的「AI 阅读」：文件文本进阅读面板（标题是文件名）
 */
const DATA = ".verify/drivefile-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const DIR = path.join(DATA, "drive");
fs.mkdirSync(DIR, { recursive: true });

const DOC = "# 季报\n\n本季度完成三件事。\n";
fs.writeFileSync(path.join(DIR, "季报.md"), DOC, "utf8");
fs.writeFileSync(path.join(DIR, "temp.md"), "# 临时\n", "utf8");

const PORT = 9308;
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

const files = () => (fs.existsSync(DIR) ? fs.readdirSync(DIR).sort() : []);

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const ctx = b.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  await page.locator('[data-testid="wb-nav-cloud"]').click();
  await page.waitForTimeout(2000);
  out.before = files();

  /* ── ① 删除要走确认 ── */
  await page.locator('[data-testid="wb-del-temp.md"]').click();
  await page.waitForTimeout(500);
  out.confirmShown = (await page.locator('[data-testid="wb-cloud-confirm"]').count()) > 0;
  out.confirmTitle = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-confirm-title"]')?.textContent?.trim() ?? "",
  );
  await page.locator('[data-testid="wb-cloud-confirm-cancel"]').click();
  await page.waitForTimeout(500);
  out.afterCancel = files();

  await page.locator('[data-testid="wb-del-temp.md"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-cloud-confirm-ok"]').click();
  await page.waitForTimeout(1500);
  out.afterDelete = files();

  /* ── ②③ 重命名（右键菜单）── */
  await page.locator('[data-testid="wb-file-季报.md"]').click({ button: "right" });
  await page.waitForTimeout(600);
  out.menuLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-drive-menu-"]')).map((e) => {
      const id = e.getAttribute("data-testid") ?? "";
      return id.replace("wb-drive-menu-", "");
    }),
  );
  await page.locator('[data-testid="wb-drive-menu-重命名"]').click();
  await page.waitForTimeout(500);
  out.renameShown = (await page.locator('[data-testid="wb-cloud-rename"]').count()) > 0;
  out.renamePrefill = await page.locator('[data-testid="wb-cloud-rename-input"]').inputValue();

  /* 先试一个**已存在**的名字（此时只剩 季报.md，先造一个重名目标） */
  fs.writeFileSync(path.join(DIR, "已有.md"), "# 已有\n", "utf8");
  await page.locator('[data-testid="wb-cloud-rename-cancel"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-cloud-refresh"]').click();
  await page.waitForTimeout(1200);
  await page.locator('[data-testid="wb-file-季报.md"]').click({ button: "right" });
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-drive-menu-重命名"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-cloud-rename-input"]').fill("已有.md");
  await page.locator('[data-testid="wb-cloud-rename-ok"]').click();
  await page.waitForTimeout(600);
  out.dupError = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-rename-err"]')?.textContent?.trim() ?? "",
  );
  out.dialogStillOpen = (await page.locator('[data-testid="wb-cloud-rename"]').count()) > 0;
  out.afterDupAttempt = files();

  /* 改成合法的新名字 */
  await page.locator('[data-testid="wb-cloud-rename-input"]').fill("本季季报.md");
  await page.locator('[data-testid="wb-cloud-rename-ok"]').click();
  await page.waitForTimeout(1500);
  out.afterRename = files();
  out.renamedContent = fs.existsSync(path.join(DIR, "本季季报.md"))
    ? fs.readFileSync(path.join(DIR, "本季季报.md"), "utf8")
    : null;

  /* ── ④ AI 阅读 ── */
  await page.locator('[data-testid="wb-file-本季季报.md"]').click({ button: "right" });
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-drive-menu-AI 阅读"]').click();
  await page.waitForTimeout(1500);
  out.readerView = (await page.locator('[data-testid="wb-reader"]').count()) > 0;
  out.readerTitle = await page.evaluate(
    () => document.querySelector('[data-testid="wb-reader-title"]')?.textContent?.trim() ?? "",
  );
  out.readerText = await page.evaluate(
    () => document.querySelector('[data-testid="wb-reader-text"]')?.textContent?.trim() ?? "",
  );
  out.shot = await shot(page, "drivefile.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ① 删除确认 */
  if (!out.confirmShown) bad.push("点删除没有出确认框");
  if (out.confirmTitle !== "确认删除文件？") bad.push(`确认框标题与证据不符：${out.confirmTitle}`);
  if (JSON.stringify(out.afterCancel) !== JSON.stringify(out.before)) {
    bad.push(`点了「取消」文件却没了：${JSON.stringify(out.afterCancel)}`);
  }
  if ((out.afterDelete ?? []).includes("temp.md")) bad.push("确认删除后文件还在");

  /* ②③ 重命名 */
  if (!out.renameShown) bad.push("右键菜单的「重命名」没打开输入框");
  if (out.renamePrefill !== "季报.md") bad.push(`重命名输入框没预填原名：${out.renamePrefill}`);
  if (!(out.dupError ?? "").includes("已经有同名文件")) bad.push(`改成已有名字没被挡住：${out.dupError}`);
  if (!out.dialogStillOpen) bad.push("改成已有名字后对话框却关掉了（应该留着让人改）");
  if (!(out.afterDupAttempt ?? []).includes("季报.md")) bad.push("改名失败时原名不该消失");
  if (!(out.afterRename ?? []).includes("本季季报.md")) {
    bad.push(`磁盘上没有改后的名字：${JSON.stringify(out.afterRename)}`);
  }
  if ((out.afterRename ?? []).includes("季报.md")) bad.push("改名后原名还在（可能是复制而不是改名）");
  if (!(out.renamedContent ?? "").includes("本季度完成三件事")) bad.push("改名后内容变了（不该动内容）");

  /* ④ AI 阅读 */
  if (!out.readerView) bad.push("「AI 阅读」没打开阅读面板");
  if (!(out.readerTitle ?? "").includes("本季季报")) bad.push(`阅读面板标题不对：${out.readerTitle}`);
  if (!(out.readerText ?? "").includes("本季度完成三件事")) bad.push("阅读面板里没有文件内容");

  /* 菜单项名称 */
  if (!(out.menuLabels ?? []).includes("AI 阅读")) bad.push(`右键菜单里没有「AI 阅读」：${JSON.stringify(out.menuLabels)}`);
  if (!(out.menuLabels ?? []).includes("重命名")) bad.push("右键菜单里没有「重命名」");

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 云盘文件操作成立：删除要确认（取消保住）/ 重命名真改磁盘且不覆盖 / 「AI 阅读」把内容送进阅读面板");
  }
}
