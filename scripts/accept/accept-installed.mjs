import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, pickPort, verdict } from "./harness.mjs";

/**
 * 验证**安装出来的**应用能跑（而不是只验证 unpacked 目录能跑）。
 *
 * 这是补 §72 里列的那个缺口："安装包已产出、解包版验过，但安装向导本身没实际走一遍"。
 * 静默安装已经跑过（退出码 0），这里验装出来的那份能不能起来并渲染。
 */
const EXE = ".verify/instA/工作台.exe";
const DATA = ".verify/instA-data";

if (!fs.existsSync(EXE)) {
  console.log(JSON.stringify({ launched: false, reason: "安装目录里没有 工作台.exe" }));
  process.exit(0);
}

fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;
// 打包后的应用**忽略命令行上的 --remote-debugging-port**（早期轮次踩过这个坑），
// 只认这个环境变量 —— 所以下面 spawn 里那个参数是没用的，靠这一行。

const report = { exeBytes: fs.statSync(EXE).size };
/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12855]);
/* 应用只认这个环境变量（命令行那个在打包产物里会被忽略）—— 两处必须是同一个端口。 */
env.DSH_DEBUG_PORT = String(__port);
const child = spawn(EXE, ["--remote-debugging-port=" + __port], {
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

await new Promise((r) => setTimeout(r, 22000));

try {
  const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
  const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  report.connected = true;
  report.url = page.url();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  report.appShellRendered = true;

  // 走两步真实交互，证明不是只渲染了个空壳
  await page.waitForTimeout(2000);
  report.navItems = await page.$$eval('[data-testid^="wb-nav-"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, "")).slice(0, 7),
  );
  await page.locator('[data-testid="wb-nav-plugins"]').click();
  await page.waitForTimeout(1500);
  report.pluginsPageOpened = (await page.locator('[data-testid="wb-plugin-add"]').count()) === 1;

  await page.locator('[data-testid="wb-plugin-add"]').click();
  await page.waitForTimeout(600);
  report.addFormOpenedInInstalledApp = (await page.locator('[data-testid="wb-add-form"]').count()) === 1;

  report.userDataDir = fs.existsSync(DATA);
  await browser.close();
} catch (error) {
  report.error = String(error).slice(0, 200);
} finally {
  console.log(JSON.stringify(report, null, 2));

  /*
   * ── 判定（2026-10-14 补）────────────────────────────────────────────
   *
   * 这条脚本验的是"**装出来的**那份能跑"（§72 列过的缺口）。它原来只打报告，
   * 于是"装出来的那份起不来 / 起来了个空壳 / 交互全死"三种回归都不会红 ——
   * 而这三种恰恰是打包最容易出的问题（asar 里少文件、路径写死开发目录）。
   *
   * ⚠️ 安装目录不存在时**是跳过不是失败**（上面已经 case 掉了）：本机没装过
   *    就该说"没装过"，不能说"装出来的坏了"。
   */
  const bad = [];
  if (report.error) bad.push(`装出来的那份起不来或渲染失败：${report.error}`);
  if (!report.connected) bad.push("调试端口没连上（进程起了但没起来）");
  if (!report.appShellRendered) bad.push("装出来的那份没有渲染出外壳（wb 根节点缺失）");
  if ((report.navItems?.length ?? 0) < 5) bad.push(`左侧导航只有 ${report.navItems?.length ?? 0} 项（装机版像是缺资源）`);
  if (!report.pluginsPageOpened) bad.push("装机版里点「技能」没打开页面");
  if (!report.addFormOpenedInInstalledApp) bad.push("装机版里「添加技能」弹不出表单（交互死）");
  if (!report.userDataDir) bad.push("装机版没有写用户数据目录（数据会丢）");

  verdict(bad, "装机版可用：连得上 / 外壳渲染 / 导航齐全 / 两处交互真的能动 / 有写用户数据目录");

  child.kill();
}
