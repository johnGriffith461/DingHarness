import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

/**
 * 打包后应用的冒烟测试：**它必须能启动并渲染出工作台界面**。
 *
 * ## 为什么要单独有这一条
 * §73–§78 那一串问题（安装包是旧的 → 应用弹 [Error] 起不来 → 主进程找不到依赖）
 * 暴露的根本缺口是：
 *
 * > **44 条验收全都跑仓库里的 `electron .`，没有一条跑打包后的应用。**
 *
 * 所以"仓库里能跑、打包后不能跑"这类问题，**任何门禁都抓不到** ——
 * 它每次都要靠人手工去装、去点，才可能撞见。
 *
 * 这一条把它变成机械检查：起 `release/win-unpacked/Ding Harness.exe`，
 * 连上去确认 `[data-testid="wb"]` 渲染出来，再关掉。
 *
 * ## 两个必须踩对的细节（都踩过）
 * · **清 `ELECTRON_RUN_AS_NODE`** —— 不清它，Electron 会当 Node 跑，
 *   静默退出（§76 为此白查了三轮）；
 * · **调试端口走 `DSH_DEBUG_PORT` 环境变量** —— 打包版忽略命令行上的
 *   `--remote-debugging-port`。
 *
 * 用法：node scripts/verify-packaged.mjs
 */

const ROOT = process.cwd();
const EXE = join(ROOT, "release", "win-unpacked", "Ding Harness.exe");
const DATA = join(ROOT, ".verify", "packaged-smoke-data");
const PORT = "9866";

if (!existsSync(EXE)) {
  console.error("✗ 找不到 " + EXE + " —— 先跑一次 `pnpm build`。");
  process.exit(1);
}

rmSync(DATA, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_DEBUG_PORT = PORT;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(EXE, [], { env, stdio: ["ignore", "pipe", "pipe"] });

/*
 * ⚠️ 管道**必须读掉**（§142）。
 *
 * 这个应用的 stderr 会刷大量 `Gpu Cache Creation failed` / `Unable to create cache`
 * 之类的报错。用 `pipe` 起进程却从不读，缓冲区（几十 KB）塞满之后
 * **子进程会阻塞在写 stderr 上** —— 启动卡住、调试端口永远不开，
 * 于是这条门禁报"连不上调试端口 9866"，看起来像**应用坏了**。
 *
 * 2026-10-12 就是这样让 `pnpm build` 红了一次。同一个缺陷形态我在 `.verify/` 下
 * 修过 43 个脚本（§137），**唯独漏了门禁自己这一处** —— 因为那时我只扫了 `accept-*.mjs`。
 * 教训：找全"这一类"时，别把范围限死在某个目录名上。
 */
let bootTail = "";
const cap = (chunk) => {
  bootTail += chunk;
  if (bootTail.length > 16384) bootTail = bootTail.slice(-4096);
};
child.stdout?.on("data", (d) => cap(String(d)));
child.stderr?.on("data", (d) => cap(String(d)));

const stop = () => {
  try {
    child.kill();
  } catch {
    /* 已经退出 */
  }
};

const fail = (message) => {
  console.error("✗ 打包后的应用冒烟测试失败：" + message);
  if (bootTail.trim()) console.error("  应用输出尾部：\n" + bootTail.trim().slice(-800));
  console.error("  排查看 %TEMP%\\ding-harness-boot.log（外壳崩溃兜底会写在那里）");
  stop();
  process.exit(1);
};

/**
 * 等调试端口真的开 —— **不要用固定 sleep 代替它**。
 *
 * 原来是"睡 14 秒然后连"，赌的是"14 秒够久"。忙机器上不够，而且失败时
 * 分不清"应用没起来"与"我还没等够"。改成等真条件（TCP 能连上），
 * 顺便把"进程提前退出"这个更具体的原因分出来。
 */
async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      const done = (v) => {
        sock.destroy();
        resolve(v);
      };
      sock.setTimeout(600);
      sock.on("connect", () => done(true));
      sock.on("timeout", () => done(false));
      sock.on("error", () => done(false));
    });
    if (ok) return true;
    if (child.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

if (child.exitCode !== null) {
  fail("进程立刻退出了（退出码 " + child.exitCode + "）。最常见的原因是漏清 ELECTRON_RUN_AS_NODE。");
}

const opened = await waitPort(Number(PORT), 45000);
if (child.exitCode !== null) {
  fail("进程在开端口前退出（退出码 " + child.exitCode + "）。最常见的原因是漏清 ELECTRON_RUN_AS_NODE。");
}
if (!opened) {
  fail(
    "45 秒内调试端口 " + PORT + " 一直没开（进程还活着，但没起 DevTools）—— " +
      "常见原因是它的 stderr 被写满阻塞（见本文件顶部关于管道的注释）。",
  );
}

let browser;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + PORT);
} catch (error) {
  fail("连不上调试端口 " + PORT + "：" + String(error).slice(0, 120));
}

try {
  const pages = browser.contexts()[0].pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
  const title = await page.title();
  const navCount = await page.$$eval('[data-testid^="wb-nav-"]', (els) => els.length);

  /*
   * 光"渲染出外壳"还不够 —— 那可能是个空壳。所以再走两步真实交互：
   * 进插件·技能页（验跳转）、打开添加表单（验渲染 + 事件）。
   * 这两步都不依赖模型，跑得快，但能把"壳起来了、里面是死的"挡在外面。
   *
   * ⚠️ 2026-10-16：这两步原来按 `wb-nav-plugins` 点 —— 那个导航项当天被**移走了**
   * （插件·技能·伙伴挪进设置里），于是这条验证在等一个永远不会出现的元素、30 秒后报
   * "界面没渲染出来"（真实原因与此无关）。现在走用户真走的那条路：
   * 账号菜单 → 设置 → 左列「插件·技能·伙伴」。判据一条没动。
   */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await page.waitForTimeout(900);
  await page.locator('[data-testid="wb-set-插件·技能·伙伴"]').click();
  await page.waitForTimeout(1400);
  const pluginsOk = (await page.locator('[data-testid="wb-plugin-add"]').count()) === 1;

  await page.locator('[data-testid="wb-plugin-add"]').click();
  await page.waitForTimeout(800);
  const formOk = (await page.locator('[data-testid="wb-add-form"]').count()) === 1;

  if (!pluginsOk || !formOk) {
    fail("外壳起来了但交互不可用（插件页 " + pluginsOk + " / 添加表单 " + formOk + "）");
  }

  console.log(
    "✓ 打包后的应用启动正常：title=「" + title + "」，导航项 " + navCount + " 个，交互可用",
  );
  await page.screenshot({ path: join(".verify", "packaged-app.png") });
  console.log("  截图：.verify/packaged-app.png");
} catch (error) {
  fail("界面没渲染出来：" + String(error).slice(0, 160));
} finally {
  await browser.close().catch(() => undefined);
  stop();
}
