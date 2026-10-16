import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { connectWithRetry, freshDir, killTree, pickPort, shot, waitForPort } from "./harness.mjs";

/**
 * 验收：左栏的全局快捷键**真的能用**（§136）。
 *
 * 为什么要有这条：那四个键位角标**早就画在左栏上**了，但全文没有任何全局按键处理 ——
 * 也就是"标签在承诺一个能力，而能力不存在"。只查"角标渲染出来没有"的断言对它完全无感
 * （角标一直在）。所以这条**真按键、看视图换了没有**，并且验两个负面情形。
 *
 * 键位依据本体左栏原文（`app-triage/dynamic-ui/route-sweep.json` 的 head）：  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * 新工作任务 Ctrl N / 定时任务 Ctrl Shift T / 插件·技能·伙伴 Ctrl Shift S / 云盘 Ctrl Shift D
 */
const DATA = ".verify/sc-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12992]);
/* 应用只认这个环境变量（命令行那个在打包产物里会被忽略）—— 两处必须是同一个端口。 */
env.DSH_DEBUG_PORT = String(__port);
const child = spawn("node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=" + __port], {
  cwd: ".",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

const out = {};
/**
 * 当前高亮的左栏项 = 当前视图（这是真实 UI 状态，不是内部变量）。
 *
 * ⚠️ 只取标签那个 `span`，**不是整个按钮** —— 按钮里还有快捷键角标（`<em class="wb-kbd">`），
 * 取整串会得到「定时任务Ctrl Shift T」。我第一版就是这么写的，于是功能明明对了、断言却报红
 * （§136 撞到）。
 */
const activeNav = (page) =>
  page.evaluate(
    () =>
      document.querySelector(".wb-nav-item.is-on span")?.textContent?.trim() ??
      document.querySelector(".wb-nav-item.is-on")?.textContent?.trim() ??
      null,
  );

try {
  /* 固定等 13 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);
  const b = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
  const page = b.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const has = async (sel) => (await page.locator(sel).count()) > 0;

  out.baseline = await activeNav(page);

  await page.keyboard.press("Control+Shift+T");
  await page.waitForTimeout(700);
  out.ctrlShiftT = { nav: await activeNav(page), page: (await has('[data-testid="wb-sched-empty"]')) || (await has('[data-testid="wb-sched-list"]')) };
  /* ⚠️ 2026-10-16：Ctrl Shift S（插件·技能·伙伴）随那一页搬进设置一起撤掉 —— 这条断言删。 */


  await page.keyboard.press("Control+n");
  await page.waitForTimeout(700);
  out.ctrlN = { nav: await activeNav(page) };

  /*
   * 负面：不带修饰键打字母、以及没定义过的组合，都**不该**把界面切走。
   * 少了这一条，"把所有 keydown 都当快捷键"这种过度实现也会绿。
   */
  await page.keyboard.press("t");
  await page.waitForTimeout(400);
  out.plainT = await activeNav(page);
  await page.keyboard.press("Control+Shift+n");
  await page.waitForTimeout(400);
  out.ctrlShiftN = await activeNav(page);

  out.shot = await shot(page, "shortcuts.png");
  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 200);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);
  const bad = [];
  if (out.ctrlShiftT?.nav !== "定时任务") bad.push("Ctrl Shift T 没切到定时任务");
  if (!out.ctrlShiftT?.page) bad.push("Ctrl Shift T 后没看到定时任务页的内容");
  /* ⚠️ 2026-10-16：Ctrl Shift D（云盘）随云盘整页一起拆了 —— 那条映射与它的断言都删掉，
     不是改个期望值：快捷键没了就是没了。 */
  if (out.ctrlN?.nav !== "新工作任务") bad.push("Ctrl N 没回到新工作任务");
  if (out.plainT !== "新工作任务") bad.push("按了个光杆 t 就把界面切走了（会导致打字误触）");
  if (out.ctrlShiftN !== "新工作任务") bad.push("没定义的 Ctrl Shift N 也把界面切走了");
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 四个快捷键都真的生效，且不误伤打字");
  }
}
