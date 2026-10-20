import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, failOnMarks, openPluginsPage, pickPort, verdict } from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

/**
 * F-05（2026-10-20）：验证**打包出来的那份**能跑，并且打包态独有的数据迁移分支也对。
 *
 * ## 换成了 win-unpacked（不再走 NSIS 静默安装）
 *
 * 原来这条脚本依赖 `.verify/instA` 里"静默安装好的"一份，而本机/CI 从来没装过 ——
 * 于是它一直是环境红，装机版等于**从没进过验收门**。NSIS 静默安装本身也不稳定
 * （杀毒、权限、残留目录）。现在直接用 `electron-builder --win dir` 的产物
 * `release/win-unpacked/Ding Harness.exe`：那就是用户装完之后磁盘上的同一批文件。
 *
 * ## 迁移分支（`migrateLegacyUserData`）
 *
 * 它只在 `app.isPackaged` 时进入，开发态永远测不到。这里造一个旧身份目录
 * （`.verify/Dingwork/legacy-marker.json`），把 `DING_DATA_DIR` 指到 `.verify/installed-data`，
 * 启动后断言：
 * - 新目录里有那份文件（迁过去了）；
 * - 旧目录里的还在（**只读旧、写新、不删旧**）；
 * - 应用自己的数据确实写在新目录。
 */
const EXE = path.join("release", "win-unpacked", "Ding Harness.exe");
const ROOT = path.resolve(".verify");
const DATA = path.join(ROOT, "installed-data");
const LEGACY = path.join(ROOT, "Dingwork");
const MARKER = "legacy-marker.json";
const MARKER_BODY = JSON.stringify({ from: "Dingwork", note: "F-05 migration probe" });

if (!fs.existsSync(EXE)) {
  /*
   * 缺产物是**环境红**（不是产品断言红）：明确说清还差哪一步。
   * `verify-acceptances.mjs` 的 `classify` 会把这句归到「环境红」那一类。
   */
  console.error(
    `打包产物不存在（${EXE}）—— 先跑 pnpm package:win（会产出 release/win-unpacked）；这条按环境红记，不算通过。`,
  );
  process.exit(1);
}

/* 干净的新目录 + 旧身份目录（旧目录里只放一个"我们的数据"标记） */
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(LEGACY, { recursive: true, force: true });
fs.mkdirSync(LEGACY, { recursive: true });
fs.writeFileSync(path.join(LEGACY, MARKER), MARKER_BODY, "utf8");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
/* DING_DATA_DIR 是当前名字；旧名继续认，但这里只用新名（覆盖生效 = F-05 的前置） */
env.DING_DATA_DIR = DATA;
delete env.DH_DATA_DIR;
delete env.DSH_CANVAS_DATA_DIR;
// 打包后的应用忽略命令行上的 --remote-debugging-port，只认这个环境变量。
const __port = await pickPort([12866]);
env.DSH_DEBUG_PORT = String(__port);

const child = spawn(EXE, ["--remote-debugging-port=" + __port], {
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

const report = { exeBytes: fs.statSync(EXE).size, dataDir: DATA, legacyDir: LEGACY };
const consoleErrors = [];
const pageErrors = [];

await new Promise((r) => setTimeout(r, 22000));

try {
  const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
  const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
  report.connected = true;
  report.url = page.url();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  report.appShellRendered = true;

  // 走两步真实交互，证明不是只渲染了个空壳
  await page.waitForTimeout(2000);
  report.navItems = await page.$$eval('[data-testid^="wb-nav-"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, "")).slice(0, 7),
  );
  /*
   * F-01：干净数据目录里首屏**只显示配置向导**（首页主体不渲染），
   * 于是输入区的「技能」chip 还不存在。按真实用户的路径点「稍后再说」再继续。
   */
  report.firstRunGuideShown = (await page.locator('[data-testid="wb-firstrun"]').count()) === 1;
  if (report.firstRunGuideShown) {
    await page.locator('[data-testid="wb-firstrun-skip"]').click();
    await page.waitForTimeout(800);
  }
  /*
   * 进**市场页**（`wb-page-plugins`）而不是管理页 —— 「添加」按钮在市场页头上，
   * 这是 2026-10-20 换到 win-unpacked 之后第一次真跑才发现的（旧脚本点的是管理页）。
   */
  await openPluginsPage(page, { market: true });
  await page.waitForTimeout(1500);
  report.pluginsPageOpened = (await page.locator('[data-testid="wb-plugin-add"]').count()) === 1;

  if (report.pluginsPageOpened) {
    await page.locator('[data-testid="wb-plugin-add"]').click();
    await page.waitForTimeout(600);
  }
  report.addFormOpenedInInstalledApp = (await page.locator('[data-testid="wb-add-form"]').count()) === 1;

  /*
   * 打包态迁移：新目录里应有旧目录的标记，旧目录本身不许被搬空/删掉。
   * 这里等到文件出现（迁移在主进程启动早期做，页面能渲染时通常已完成）。
   */
  report.migratedIntoNewData = fs.existsSync(path.join(DATA, MARKER));
  report.legacyStillThere = fs.existsSync(path.join(LEGACY, MARKER));
  try {
    report.migratedBodyMatches = fs.readFileSync(path.join(DATA, MARKER), "utf8") === MARKER_BODY;
  } catch {
    report.migratedBodyMatches = false;
  }
  report.userDataDir = fs.existsSync(DATA) && fs.readdirSync(DATA).length > 0;

  /* 让页面里的事件循环走一轮，把迟到的 console.error 也收进来 */
  await page.waitForTimeout(800);
  report.consoleErrors = consoleErrors;
  report.pageErrors = pageErrors;
  await browser.close();
} catch (error) {
  report.error = String(error).slice(0, 300);
} finally {
  console.log(JSON.stringify(report, null, 2));

  const bad = [];
  if (report.error) bad.push(`装出来的那份起不来或渲染失败：${report.error}`);
  if (!report.connected) bad.push("调试端口没连上（进程起了但没起来）");
  if (!report.appShellRendered) bad.push("装出来的那份没有渲染出外壳（wb 根节点缺失）");
  if ((report.navItems?.length ?? 0) < 5) bad.push(`左侧导航只有 ${report.navItems?.length ?? 0} 项（装机版像是缺资源）`);
  if (!report.pluginsPageOpened) bad.push("装机版里点「技能」没打开页面");
  if (!report.addFormOpenedInInstalledApp) bad.push("装机版里「添加技能」弹不出表单（交互死）");
  if (!report.userDataDir) bad.push("装机版没有写用户数据目录（数据会丢）");
  if (!report.migratedIntoNewData) bad.push("旧身份数据目录没有被迁移到新目录");
  if (!report.migratedBodyMatches) bad.push("迁移过去的文件内容与旧目录不一致");
  if (!report.legacyStillThere) bad.push("旧数据目录被删掉了（规矩是只读旧、写新、不删旧）");
  if (report.pageErrors?.length) bad.push(`页面抛了 ${report.pageErrors.length} 个异常：${report.pageErrors[0]}`);
  /* F-01：装完第一眼必须是配置向导（不是空首页），且能点「稍后再说」走开 */
  if (report.firstRunGuideShown !== true) bad.push("干净数据目录启动时没有出现配置向导（首屏该只有这一个主动作）");
  if (report.consoleErrors?.length) bad.push(`控制台有 ${report.consoleErrors.length} 条 error：${report.consoleErrors[0]}`);

  verdict(bad, "装机版可用：连得上 / 外壳渲染 / 导航齐全 / 两处交互能动 / 写新数据目录 / 旧数据迁移且不删旧 / 控制台无 error");

  child.kill();
}
