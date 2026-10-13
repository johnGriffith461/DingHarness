import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * 验证**安装出来的**应用能跑（而不是只验证 unpacked 目录能跑）。
 *
 * 这是补 §72 里列的那个缺口："安装包已产出、解包版验过，但安装向导本身没实际走一遍"。
 * 静默安装已经跑过（退出码 0），这里验装出来的那份能不能起来并渲染。
 */
const EXE = "D:/DoubaoWorkClone/.verify/instA/工作台.exe";
const DATA = "D:/DoubaoWorkClone/.verify/instA-data";

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
env.DSH_DEBUG_PORT = "9855";

const report = { exeBytes: fs.statSync(EXE).size };
const child = spawn(EXE, ["--remote-debugging-port=9855"], {
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

await new Promise((r) => setTimeout(r, 22000));

try {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9855");
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
  child.kill();
}
