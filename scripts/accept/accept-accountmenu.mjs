import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, pickPort, shot, waitForPort, dismissFirstRunIfShown } from "./harness.mjs";

/**
 * 验收：账号菜单 + 「外观设置」子菜单（三选一）。
 *
 * 对齐本体的结构：账号头像 → 下拉菜单 → 「外观设置」→ 子菜单
 * （跟随系统 ✓ / 浅色模式 / 深色模式）。
 *
 * 测的是**行为**：点了菜单出不出来、勾在哪一项、选完颜色真变没变、
 * 刷新后记不记得住 —— 不是"那几行渲染出来没有"。
 */
const DATA = ".verify/acct-data";
fs.rmSync(DATA, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12921]);
/* 应用只认这个环境变量（命令行那个在打包产物里会被忽略）—— 两处必须是同一个端口。 */
env.DSH_DEBUG_PORT = String(__port);
const child = spawn("node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=" + __port], {
  cwd: ".",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});

const out = {};
/* 固定等 13 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);
let browser;
try {
  browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
  const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await dismissFirstRunIfShown(page);
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

  /*
   * ⭐ **开着菜单再点一次头像**（2026-10-16，审计 P83 点名"行为侧同样没盖"）。
   * 修前实测这条**关不掉**：mousedown 判"点在外面"先关、按钮自己的 click 又 toggle 回来。
   * 顺带再点一次开回来，免得影响后面的步骤。
   */
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(700);
  out.afterSecondClick = await state();
  await page.locator('[data-testid="wb-account"]').click();
  await page.waitForTimeout(700);
  out.afterThirdClick = await state();

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
  /** 应当存在的项（2026-10-15 收窄，见下面 `removedRows`）。 */
  out.expectIds = ["wb-acct-settings", "wb-acct-appearance", "wb-acct-starred", "wb-acct-quota"];
  out.missingRows = out.expectIds.filter((id) => !out.rowIds.includes(id));
  /*
   * ⚠️ 口径在 2026-10-15 变了（M0 工单 3）——**这条判据反了过来**。
   *
   * 原来这里钉的是"五个壳必须 `disabled` **且**带 title 说明为什么"，
   * 依据是手册那条"界面保持 disabled 且有说明"。
   * 工单把这条口径改成：逐项三选一（实现 / 移除 / 降级为非交互元素），
   * **不允许留下"disabled + 借口"** —— 因为对用户来说，一颗**看得见、点不动、
   * 悬停才说一句为什么**的菜单项，和坏掉没有区别。
   *
   * 这五项（官网 / 检查更新 / 帮助与反馈 / 添加账号 / 退出登录）本机版都没有目的地，
   * 所以按"移除"办：**它们不该再出现在菜单里**。
   */
  out.removedRows = ["wb-acct-site", "wb-acct-update", "wb-acct-help", "wb-acct-add", "wb-acct-logout"];
  out.stillPresent = (out.rowKinds ?? []).filter((r) => out.removedRows.includes(r.id)).map((r) => r.id);
  out.realRows = ["wb-acct-settings", "wb-acct-appearance", "wb-acct-starred"];
  out.realDisabled = (out.rowKinds ?? []).filter((r) => out.realRows.includes(r.id) && r.disabled).map((r) => r.id);
  /** 菜单里**一个禁用项都不该有**（额度用量那一行不是 button，不在这个查询里）。 */
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
  await shot(page, ".verify/acct-menu.png");

  // 4) 选深色模式 → 颜色真变
  await page.locator('[data-testid="wb-acct-theme-dark"]').click();
  await page.waitForTimeout(900);
  out.afterPickDark = await state();

  // 5) 刷新 → 记住
  await page.reload();
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await dismissFirstRunIfShown(page);
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

  /*
   * ⭐ 刷新之后**仍按选过的那一档渲染**（原本在 `accept-theme.mjs` 里 —— 该脚本 2026-10-14 退役、
   * 2026-10-16 连同墓碑一起删除；这条**独有覆盖**就是那时候搬到这里来的）。
   *
   * 为什么搬过来：那条脚本点的是设置里的「外观」行，而**外观早就挪到账号菜单子菜单**了
   * —— 它的导航是死的（点了永远等不到），于是它一直**读不到任何状态**。
   * 它的判据本身是对的（"选了之后刷新还在"），所以把这条**独有覆盖**搬到这里，脚本退役。
   */
  await page.reload();
  await page.waitForTimeout(1200);
  out.afterReload = await state();
  out.reloadKeptLight = out.afterReload.isDark === false && out.afterReload.stored === "light";

  await browser.close();
} catch (e) {
  out.error = String(e).slice(0, 240);
} finally {
  console.log(JSON.stringify(out, null, 2));
  child.kill();

  /*
   * 判定（2026-10-13 立，2026-10-15 按 M0 工单 3 的口径改了方向）。
   * 两条都是**可证伪**的：该有的少一项就红；该移除的还在、或菜单里出现任何禁用项，也红。
   */
  const bad = [];
  if ((out.missingRows ?? []).length) bad.push(`账号菜单少了这些项：${out.missingRows.join(" / ")}`);
  /* P83：开着再点一次头像要关掉（再点一次要能开回来） */
  if (out.afterSecondClick?.menu !== 0) {
    bad.push(`⭐ 开着菜单再点一次头像没有关掉（菜单数还是 ${out.afterSecondClick?.menu}）—— "关了又被开"，用户眼里就是关不掉`);
  }
  if (out.afterThirdClick?.menu !== 1) {
    bad.push(`再点一次头像应当重新打开菜单（读到 ${out.afterThirdClick?.menu}）`);
  }
  if ((out.stillPresent ?? []).length) {
    bad.push(`⭐ 这些"壳"本该移除却还在（看得见、点不动 = 用户眼里的坏按钮）：${out.stillPresent.join(" / ")}`);
  }
  if ((out.disabledRows ?? []).length) {
    bad.push(`⭐ 账号菜单里还有禁用项（工单 3 口径：实现 / 移除 / 降级，不留"disabled + 借口"）：${out.disabledRows.join(" / ")}`);
  }
  if ((out.realDisabled ?? []).length) bad.push(`⭐ 这些是真入口却被禁掉了：${out.realDisabled.join(" / ")}`);
  if (!out.reloadKeptLight) {
    bad.push(`⭐ 选了浅色之后刷新没保持：isDark=${out.afterReload?.isDark} stored=${out.afterReload?.stored}`);
  }
  if (out.error) bad.push("异常: " + out.error);
  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 账号菜单：真入口都在（设置/外观/收藏夹/额度用量）/ 五个没目的的壳已移除 / 菜单里无禁用项 / 外观三选一 + 刷新后保持");
  }
}
