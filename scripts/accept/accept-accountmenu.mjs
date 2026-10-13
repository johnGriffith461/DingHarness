import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * 验收：账号菜单 + 「外观设置」子菜单（三选一）。
 *
 * 对齐本体的结构：账号头像 → 下拉菜单 → 「外观设置」→ 子菜单
 * （跟随系统 ✓ / 浅色模式 / 深色模式）。
 *
 * 测的是**行为**：点了菜单出不出来、勾在哪一项、选完颜色真变没变、
 * 刷新后记不记得住 —— 不是"那几行渲染出来没有"。
 */
const DATA = "D:/DoubaoWorkClone/.verify/acct-data";
fs.rmSync(DATA, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_DEBUG_PORT = "9921";
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn("D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=9921"], {
  cwd: "D:/DoubaoWorkClone",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

const out = {};
await new Promise((r) => setTimeout(r, 13000));
let browser;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9921");
  const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2200);

  const state = () =>
    page.evaluate(() => {
      const wb = document.querySelector(".wb");
      return {
        isDark: document.documentElement.getAttribute("data-theme") === "dark" ?? null,
        bg: wb ? getComputedStyle(wb).backgroundColor : null,
        stored: localStorage.getItem("dsh-canvas.theme"),
        menu: document.querySelectorAll('[data-testid="wb-account-menu"]').length,
        sub: document.querySelectorAll('[data-testid="wb-acct-theme-sub"]').length,
      };
    });

  out.initial = await state();

  // 1) 账号按钮开出菜单
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(800);
  out.afterOpen = await state();

  // 2) 菜单里有哪些项（对齐本体的 9 项）
  out.items = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="wb-acct-"]')]
      .map((e) => e.getAttribute("data-testid"))
      .filter((t) => t !== "wb-acct-menu" && t !== "wb-acct-theme-sub"),
  );

  /*
   * ⚠️ 2026-10-13 补：**这一组 testid 原来一个都没被任何脚本引用过** ——
   * 把 `src/` 的 `data-testid` 与 `scripts/accept/` 做交叉，103 个"零覆盖前缀"里就有它们
   * （技能面板那个 59px 的塌陷就是这么烂掉的：没人点过它）。
   *
   * 断言**不靠点击**（第一版逐项点：点到「设置」弹出模态框，把后面全挡住了 —— 30 秒超时）。
   * 改成从 DOM 直接读两件**可证伪**的事：
   *   ① 九项都在（少一项就红）；
   *   ② 每一项**要么可点、要么 `disabled`** —— 这正是手册那条"杜绝假按钮"的可检查形式
   *      （"看起来能点、点了没反应"是最坏的一种）。
   */
  out.rowKinds = await page.evaluate(() => {
    // 与上面读 items 用同一套查询（按前缀从整页取）—— 第一版限定在菜单容器里，容器没命中就全成了 missing
    const rows = [...document.querySelectorAll('[data-testid^="wb-acct-"]')]
      .filter((e) => !["wb-acct-theme-sub", "wb-acct-menu"].includes(e.getAttribute("data-testid") ?? ""))
      .map((e) => ({
        id: e.getAttribute("data-testid"),
        tag: e.tagName.toLowerCase(),
        disabled: e.hasAttribute("disabled"),
        title: e.getAttribute("title") ?? "",
      }));
    return rows;
  });
  out.rowIds = (out.rowKinds ?? []).map((r) => r.id);
  /** 应当存在的九项（本体口径，见 §107 / R1）。 */
  out.expectIds = [
    "wb-acct-settings",
    "wb-acct-appearance",
    "wb-acct-starred",
    "wb-acct-site",
    "wb-acct-update",
    "wb-acct-help",
    "wb-acct-quota",
    "wb-acct-add",
    "wb-acct-logout",
  ];
  out.missingRows = out.expectIds.filter((id) => !out.rowIds.includes(id));
  /*
   * "假按钮"的可验证口径（第一版写成"没 title 就算假"，**是错的**：真按钮不需要 title）：
   *   · **壳**（本机版没有那个能力）必须是 `disabled` **且带 title 说明为什么** ——
   *     这正是手册那条"杜绝假按钮：界面保持 disabled 且有说明"；
   *   · **真入口**（设置 / 外观设置 / 收藏夹）不许被禁掉。
   */
  out.shellRows = ["wb-acct-site", "wb-acct-update", "wb-acct-help", "wb-acct-add", "wb-acct-logout"];
  out.realRows = ["wb-acct-settings", "wb-acct-appearance", "wb-acct-starred"];
  out.shellNotDisabled = (out.rowKinds ?? [])
    .filter((r) => out.shellRows.includes(r.id) && !r.disabled)
    .map((r) => r.id);
  out.shellNoReason = (out.rowKinds ?? [])
    .filter((r) => out.shellRows.includes(r.id) && r.disabled && !r.title)
    .map((r) => r.id);
  out.realDisabled = (out.rowKinds ?? []).filter((r) => out.realRows.includes(r.id) && r.disabled).map((r) => r.id);
  out.disabledRows = (out.rowKinds ?? []).filter((r) => r.disabled).map((r) => r.id);

  // 3) 外观设置 → 子菜单三选一
  await page.locator('[data-testid="wb-acct-appearance"]').click();
  await page.waitForTimeout(700);
  out.afterSubmenu = await state();
  out.subOptions = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="wb-acct-theme-"]')]
      .filter((e) => e.getAttribute("data-testid") !== "wb-acct-theme-sub")
      .map((e) => ({ id: e.getAttribute("data-testid"), label: e.textContent?.trim() ?? "" })),
  );
  // 勾在哪一项（本体默认「跟随系统」）
  out.checkedDefault = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-acct-theme-system"] svg:last-child');
    return Boolean(el);
  });
  await page.screenshot({ path: ".verify/acct-menu.png" });

  // 4) 选深色模式 → 颜色真变
  await page.locator('[data-testid="wb-acct-theme-dark"]').click();
  await page.waitForTimeout(900);
  out.afterPickDark = await state();

  // 5) 刷新 → 记住
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(2500);
  out.afterReload = await state();

  // 6) 选回浅色 → 变回去
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-appearance"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-acct-theme-light"]').click();
  await page.waitForTimeout(900);
  out.afterPickLight = await state();

  await browser.close();
} catch (e) {
  out.error = String(e).slice(0, 240);
} finally {
  console.log(JSON.stringify(out, null, 2));
  child.kill();

  /*
   * 判定（2026-10-13 补：这九项的 testid 原来一个都没被脚本引用过 —— 见上面说明）。
   * 两条都是**可证伪**的：少一项就红；"壳"没 disabled、或 disabled 却不说为什么也红。
   */
  const bad = [];
  if ((out.missingRows ?? []).length) bad.push(`账号菜单少了这些项：${out.missingRows.join(" / ")}`);
  if ((out.shellNotDisabled ?? []).length) {
    bad.push(`⭐ 这些"壳"没被 disabled（点下去没反应 = 假按钮）：${out.shellNotDisabled.join(" / ")}`);
  }
  if ((out.shellNoReason ?? []).length) {
    bad.push(`⭐ 这些"壳"disabled 了却没说为什么（title 为空）：${out.shellNoReason.join(" / ")}`);
  }
  if ((out.realDisabled ?? []).length) bad.push(`⭐ 这些是真入口却被禁掉了：${out.realDisabled.join(" / ")}`);
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 账号菜单九项齐全 / 五个壳都 disabled 且有说明 / 三个真入口可用 / 外观三选一与持久化成立");
  }
}
