import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, freshDir, killTree, shot } from "./harness.mjs";

/**
 * 验收：**云盘的证据层**（§157，对应 `drive_*` 201 条里补的那一层）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 六条断言：
 * ① 标签页是本体的四个（全部 / 我的 / 最近 / AI 文档），点击能切
 * ② **筛选**：选「图片」之后只剩图片（列表行数真的变了）
 * ③ 排序：按文件名 + **倒序**真的把顺序翻过来
 * ④ **新建菜单**：三个条目都在；新建文档给「未命名文档.md」；**重名加序号不覆盖**
 * ⑤ 「已经到底了」在列表末尾
 * ⑥ 存储行是「已使用 X」（**没有百分比** —— 本机版没有配额，不编）
 */
const DATA = "D:/DoubaoWorkClone/.verify/driveops-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const DIR = path.join(DATA, "drive");
const ARTIFACTS = path.join(DATA, "artifacts");
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });

/*
 * ── 预置 ──
 *
 * ⭐ `origin` **不是文件里写的字段，是主进程按"文件在哪个目录"判定的**：
 * `artifacts/` = 产物（AI 文档）、`exports/` = 导出、`drive/` = 导进来的。
 * 第一版我把三条文件都直接写进 `drive/`，于是没有一条是产物，
 * 「AI 文档」当然是 0 行 —— 红得对，是我造的数据不符合系统口径。
 */
fs.writeFileSync(path.join(ARTIFACTS, "b-产物.md"), "# B\n", "utf8");
fs.writeFileSync(path.join(DIR, "a-文档.md"), "# A\n", "utf8");
fs.writeFileSync(path.join(DIR, "c-图片.png"), "\x89PNG\r\n\x1a\n", "utf8");
/* 时间是主进程按文件系统读的，这里不改文件时间戳（改了反而假） */

const PORT = 9307;
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

/*
 * 新建会弹输入框：桩掉它。
 *
 * ⚠️ 用 `page.evaluate` 直接赋值，**不要用 `addInitScript`** ——
 * 后者只对"之后的导航"生效，而这个应用是 SPA（点左栏不刷新页面），
 * 所以 init script 根本不会跑，prompt 还是原生的那个 → 卡住。
 * （第一版就是这么错的：以为桩上了，其实没有。）
 */
const stubPrompt = (page, value) => page.evaluate((v) => { window.prompt = () => v; }, value);

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = b.contexts()[0];
  let page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  /*
   * 新建会弹输入框。桩成**空串**：我的实现是 `raw.trim() || untitledName(...)`，
   * 于是空串会走默认名 —— 这样正好验到「未命名文档.md → 重名加序号」这条逻辑。
   * （第一版桩成 null = 用户取消，结果什么都没建，我却在断言"没落盘"，属于自欺。）
   */
  await stubPrompt(page, "");

  await page.locator('[data-testid="wb-nav-cloud"]').click();
  await page.waitForTimeout(2000);

  /* ── ① 标签页 ── */
  out.tabLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-cloud-tab-"]')).map((e) => (e.textContent ?? "").trim()),
  );
  out.allRows = await page.locator(".wb-tr:not(.wb-th)").count();
  await page.locator('[data-testid="wb-cloud-tab-aidocs"]').click();
  await page.waitForTimeout(600);
  out.aiDocRows = await page.locator(".wb-tr:not(.wb-th)").count();
  await page.locator('[data-testid="wb-cloud-tab-all"]').click();
  await page.waitForTimeout(600);

  /* ── ② 筛选 ── */
  out.filterOptions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="wb-cloud-filter"] option')).map((e) =>
      (e.textContent ?? "").trim(),
    ),
  );
  await page.locator('[data-testid="wb-cloud-filter"]').selectOption("image");
  await page.waitForTimeout(600);
  out.imageRows = await page.locator(".wb-tr:not(.wb-th)").count();
  out.imageOnly = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-file-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("wb-file-", ""),
    ),
  );
  await page.locator('[data-testid="wb-cloud-filter"]').selectOption("all");
  await page.waitForTimeout(400);

  /* ── ③ 排序 ── */
  await page.locator('[data-testid="wb-cloud-sort"]').selectOption("name");
  await page.waitForTimeout(500);
  out.ascNames = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-file-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("wb-file-", ""),
    ),
  );
  await page.locator('[data-testid="wb-cloud-sort-dir"]').click();
  await page.waitForTimeout(500);
  out.descNames = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-file-"]')).map((e) =>
      (e.getAttribute("data-testid") ?? "").replace("wb-file-", ""),
    ),
  );
  out.sortDirLabel = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-sort-dir"]')?.getAttribute("title") ?? "",
  );

  /* ── ⑤⑥ 到底了 + 存储行 ── */
  out.pageEnd = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-page-end"]')?.textContent?.trim() ?? "",
  );
  out.storage = await page.evaluate(
    () => document.querySelector('[data-testid="wb-cloud-storage"]')?.textContent?.trim() ?? "",
  );

  /* ── ④ 新建菜单 ── */
  await page.locator('[data-testid="wb-cloud-new"]').click();
  await page.waitForTimeout(400);
  out.menuItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="wb-cloud-new-"]'))
      .filter((e) => e.getAttribute("data-testid") !== "wb-cloud-new")
      .map((e) => (e.textContent ?? "").trim()),
  );
  await page.locator('[data-testid="wb-cloud-new-doc"]').click();
  await page.waitForTimeout(1500);
  out.afterFirst = fs.readdirSync(DIR).sort();
  // 再建一次（同名 → 应该加序号，不能覆盖）
  await page.locator('[data-testid="wb-cloud-new"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="wb-cloud-new-doc"]').click();
  await page.waitForTimeout(1500);
  out.afterSecond = fs.readdirSync(DIR).sort();
  out.shot = await shot(page, "drive-ops.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  /* ① 标签页 */
  const wantTabs = ["全部", "我的", "最近", "AI 文档", "收藏"];
  for (const label of wantTabs) {
    if (!(out.tabLabels ?? []).includes(label)) bad.push(`标签页里缺「${label}」：${JSON.stringify(out.tabLabels)}`);
  }
  if ((out.aiDocRows ?? 0) !== 1) bad.push(`「AI 文档」页应只有 1 份产物文档，实际 ${out.aiDocRows}`);

  /* ② 筛选 */
  if (!(out.filterOptions ?? []).includes("所有类型")) bad.push("筛选下拉里没有「所有类型」");
  if ((out.imageRows ?? 0) !== 1) bad.push(`筛「图片」后应只剩 1 行，实际 ${out.imageRows}`);
  if (!(out.imageOnly ?? []).every((n) => n.endsWith(".png"))) {
    bad.push(`筛「图片」后还有非图片：${JSON.stringify(out.imageOnly)}`);
  }

  /* ③ 排序 */
  // 产物预置在 artifacts/ 里，名字是 b-产物.md（origin 由目录决定，见上面的预置说明）
  if (JSON.stringify(out.ascNames) !== JSON.stringify(["a-文档.md", "b-产物.md", "c-图片.png"])) {
    bad.push(`按文件名正序不对：${JSON.stringify(out.ascNames)}`);
  }
  if (JSON.stringify(out.descNames) !== JSON.stringify([...(out.ascNames ?? [])].reverse())) {
    bad.push(`点「倒序」后顺序没翻过来：${JSON.stringify(out.descNames)}`);
  }

  /* ⑤⑥ */
  if (out.pageEnd !== "已经到底了") bad.push(`列表末尾没有「已经到底了」：${out.pageEnd}`);
  if (!/^已使用 /.test(out.storage ?? "")) bad.push(`存储行不对：${out.storage}`);
  if ((out.storage ?? "").includes("%")) bad.push("本机版没有配额，存储行不该出现百分比");

  /* ④ 新建 */
  if (JSON.stringify(out.menuItems) !== JSON.stringify(["新建文档", "新建文件夹", "新建 PPT"])) {
    bad.push(`新建菜单与证据不符：${JSON.stringify(out.menuItems)}`);
  }
  if (!(out.afterFirst ?? []).includes("未命名文档.md")) {
    bad.push(`新建文档没落盘：${JSON.stringify(out.afterFirst)}`);
  }
  if (!(out.afterSecond ?? []).includes("未命名文档 2.md")) {
    bad.push(`重名没加序号（可能覆盖了）：${JSON.stringify(out.afterSecond)}`);
  }
  if ((out.afterSecond ?? []).length !== (out.afterFirst ?? []).length + 1) {
    bad.push("第二次新建没有多出一个文件（覆盖嫌疑）");
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 云盘证据层成立：四个标签页 / 筛选 / 排序（含倒序）/ 新建菜单（重名加序号）/ 已经到底了 / 已使用");
  }
}
