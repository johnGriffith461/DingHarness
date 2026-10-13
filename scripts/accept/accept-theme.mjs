/*
 * ⚠️ **已退役（2026-10-14）**：这条脚本点的是设置弹窗里的「外观」行，而外观**早就挪到账号菜单的
 * 子菜单**（`wb-acct-appearance` / `wb-acct-theme-*`）—— 导航是死的（点了永远等不到），
 * 而它**没有判定**，所以一直 exit 0 混在批跑里。
 *
 * 它的判据已由 `scripts/accept/accept-accountmenu.mjs` 接住（三选一 + 持久化 + **刷新后仍按选过的那档渲染**）。
 * 保留这个文件是为了留个墓碑：**下次有人想加"外观"脚本，去改 accountmenu 那条，别再开一条**。
 * 想复活它：先把导航改成账号菜单 → 外观设置。
 */
﻿import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * 验收：设置里的「外观」是真开关 —— 点了会变、刷新后记住、能切回来。
 *
 * 这正是这个项目反复在清的那类缺陷（"看着有、其实没用"），
 * 所以**必须点一遍看计算样式真变了**，而不是只看那一行有没有渲染出来。
 */
const DATA = "D:/DoubaoWorkClone/.verify/theme-data";
fs.rmSync(DATA, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_DEBUG_PORT = "9888";
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9888"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);

const report = {};
const read = (page) =>
  page.evaluate(() => {
    const wb = document.querySelector(".wb");
    return {
      isDark: document.documentElement.getAttribute("data-theme") === "dark" ?? null,
      bg: wb ? getComputedStyle(wb).backgroundColor : null,
      stored: localStorage.getItem("dsh-canvas.theme"),
    };
  });

await new Promise((r) => setTimeout(r, 13000));
let browser;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9888");
  const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2200);

  report.initial = await read(page);

  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(900);
  report.rowValue = await page.locator('[data-testid="wb-set-theme-value"]').textContent();

  await page.locator('[data-testid="wb-set-外观"]').click();
  await page.waitForTimeout(1000);
  report.afterToggle = await read(page);
  report.rowValueAfter = await page.locator('[data-testid="wb-set-theme-value"]').textContent();

  await page.screenshot({ path: ".verify/theme-toggled.png" });

  // 切回来，确认是双向的
  await page.locator('[data-testid="wb-set-外观"]').click();
  await page.waitForTimeout(900);
  report.afterToggleBack = await read(page);

  // 再切成深色，然后刷新，确认"记住"
  await page.locator('[data-testid="wb-set-外观"]').click();
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2500);
  report.afterReload = await read(page);

  await browser.close();
} catch (error) {
  report.error = String(error).slice(0, 200);
} finally {
  console.log(JSON.stringify(report, null, 2));
  child.kill();

  /*
   * 判定（2026-10-13 补）：这条原来只有 `console.log(report)`，而且外面是 try/catch ——
   * 于是连"中途炸了"也只是把 error 写进报告、照样 exit 0（批跑里等于"静默不测"）。
   *
   * 断的是「外观」这个开关的**三件后果**（脚本自己就是这么读的）：
   *   ① 点一下真的变：生效的 `data-theme` 翻转 —— 不是"看着有、其实没用"的假开关
   *   ② 再点一下切得回来（两侧都要能用，只做单向的话等于只能变深不能变浅）
   *   ③ 刷新之后**按存下来的那一档渲染**：stored=dark 就该是深色、light 就该是浅色、
   *      system 就跟随系统（即与初始值一致）—— 这是 `theme.ts` 里 `resolvesToDark` 的口径。
   *      这样写**不依赖"点一下是几态循环"**，只依赖"存了什么就该渲染什么"。
   *
   * ⚠️ 已知（读源码与 git 全历史核过，不是猜）：这条脚本点的
   * `[data-testid="wb-set-外观"]` 在设置里**从来不存在** —— SettingsDialog 的 rows 里
   * 没有「外观」这一行（只剩一个 `r.label === "外观"` 的死渲染分支），
   * 外观现在是**账号菜单里的子菜单**（`wb-acct-appearance` / `wb-acct-theme-*`）。
   * 所以这一段**大概率会红**，红的是脚本的导航过期、不是产品坏了 ——
   * 而那正是"它一直在静默通过"该被报出来的事。导航修好（改走账号菜单）之后，
   * 下面这几条判据不需要改。
   */
  const bad = [];
  const at = (k) => report[k] ?? {};
  if (report.error) bad.push(`脚本中途出错了（选择器/入口过期？）：${report.error}`);
  for (const k of ["initial", "afterToggle", "afterToggleBack", "afterReload"]) {
    if (typeof at(k).isDark !== "boolean") bad.push(`${k} 没读到有效状态（缺字段或那一步没跑到）`);
  }
  const dark = (v) => (v ? "深色" : "浅色");
  if (typeof at("initial").isDark === "boolean" && typeof at("afterToggle").isDark === "boolean") {
    if (at("afterToggle").isDark === at("initial").isDark) {
      bad.push(`点了「外观」生效值没变（${dark(at("initial").isDark)} → ${dark(at("afterToggle").isDark)}）—— 假开关`);
    }
  }
  if (typeof at("afterToggleBack").isDark === "boolean" && typeof at("initial").isDark === "boolean") {
    if (at("afterToggleBack").isDark !== at("initial").isDark) {
      bad.push("再点一次没切回原状 —— 「双向」不成立（只能变过去、变不回来）");
    }
  }
  const stored = at("afterReload").stored;
  if (stored !== "light" && stored !== "dark" && stored !== "system") {
    bad.push(`刷新后 localStorage 里那一档不是三档之一：${JSON.stringify(stored)}（选择没落盘）`);
  } else if (typeof at("afterReload").isDark === "boolean") {
    const wantDark = stored === "dark" ? true : stored === "light" ? false : Boolean(at("initial").isDark);
    if (at("afterReload").isDark !== wantDark) {
      bad.push(
        `刷新后没按存下来的那一档渲染：stored=${stored} 应为${dark(wantDark)}，实际是${dark(at("afterReload").isDark)}（"刷新就丢"）`,
      );
    }
  }
  if (bad.length) {
    console.error("✗ 外观开关：" + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 外观开关：点了真变 / 再点切得回来 / 刷新后按存下来的那一档渲染");
  }
}
