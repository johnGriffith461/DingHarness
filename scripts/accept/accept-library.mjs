import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, openPluginsPage, readStoreFile, shot } from "./harness.mjs";

/**
 * 插件安装（11.7）与项目分组（11.8）的验收。
 *
 * **验证分工要说清楚**：
 *   · 「装/启用/项目/置顶 能持久化」→ 端到端（磁盘上真写、重启真还在）
 *   · 「启用项会进任务的系统提示词」→ 单测（`library.test.ts` 的 enabledPromptBlock 三条）
 * 后一条没在端到端里做，是因为调试出口是 DEV-only，构建版拿不到；
 * 硬用模型回复去反推会变成不稳定的断言。所以这里只验到"启用项进了界面与库"。
 *
 * ── 2026-10-14 两个真问题（都当场改了）──
 *
 * ① **起应用的方式**：原来是"自己 spawn + `waitForPort` + connect"，判据只有**端口开着**。
 *    这台机器上存在「TCP 通、Electron 的调试服务器不答」的端口区间（见 `bootApp` 的注释），
 *    于是这条脚本连着三次 `connectOverCDP: connect ETIMEDOUT` —— 读的人只会以为脚本坏了，
 *    其实是判据选错了。改用 `bootApp`（它真的问一次 CDP，不通就换底座重试）。
 *
 * ② **"归入项目"之后就没有「最近」行了**：被归入的那条线程从「最近」搬进了项目，
 *    而下面原来要再悬停一次「最近」行去置顶 —— 于是第二次 `hover` 永远等不到元素。
 *    所以**置顶必须排在归入前面**（顺序不是风格问题，是"行还在不在"的问题）。
 *
 * ── ⚠️ 这条**还不能当成绿的**（2026-10-14 如实记录）──
 *
 * 三件事一起说：
 *   · 它**不在免模型批跑**里（`scripts/verify-acceptances.mjs` 的清单没有它），
 *     所以它红不红没人看见 —— 这正是它一路烂到现在的原因；
 *   · 它**一条断言都没有**，只 `console.log` 一份 JSON。"报告不算验收"，
 *     现在它的输出得靠人读，而人是不会读的；
 *   · 后半段还有**已知过期**：技能弹层的 `wb-skill-toggle-*` 现在是空的
 *     （testid 漂了），重启那一段读 `wb-installed-count` 之前**没有先回到插件页**，
 *     所以拿到 null 也不算"库丢了"。
 *
 * 结论：修好它是**另一件独立的活**（重写 + 加判定），别在这里顺手缝。
 * 在那之前：**不要引用这条脚本来证明任何事**。
 */
const DATA = ".verify/lib-data";
fs.rmSync(DATA, { recursive: true, force: true });

/**
 * 起应用。
 *
 * 不再自己拼 env 与 EXE 路径 —— `dataDir` 由 `bootApp` 设成 `DSH_CANVAS_DATA_DIR`。
 * `getLog` 一起回传：脚本炸了要能看见**应用自己**的最后几行输出，
 * 否则只剩一句 Playwright 的超时，读的人无从下手。
 */
async function launch(port) {
  const booted = await bootApp({ port, dataDir: DATA, timeoutMs: 40000 });
  /* 用实际端口（bootApp 换过端口时它与首选不同） */
  if (!booted.ok) throw new Error("应用起不来：" + booted.getLog());
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
  const pages = browser.contexts()[0].pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { child: booted.child, browser, page, getLog: booted.getLog };
}

const report = {};
const libFile = path.join(DATA, "library.json");
const readLib = () => (fs.existsSync(libFile) ? readStoreFile(libFile) : null);

let child = null;
let browser = null;
let page = null;
let getLog = () => "";

try {
  ({ child, browser, page, getLog } = await launch(9310));

  /* ---------- 11.7 插件安装 ---------- */
  await openPluginsPage(page);
  await page.waitForTimeout(1200);
  report.installedCountBefore = await page.locator('[data-testid="wb-installed-count"]').textContent();

  // 装两个（一个插件、一个技能）
  await page.locator('[data-testid="wb-plugin-tab-技能"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-install-stock-research"]').click();
  await page.waitForTimeout(700);
  await page.locator('[data-testid="wb-plugin-tab-插件"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-install-feishu"]').click();
  await page.waitForTimeout(900);

  report.installedCountAfter = await page.locator('[data-testid="wb-installed-count"]').textContent();
  report.installButtons = {
    stock: await page.locator('[data-testid="wb-install-stock-research"]').textContent().catch(() => null),
    feishu: await page.locator('[data-testid="wb-install-feishu"]').textContent().catch(() => null),
  };
  report.libAfterInstall = readLib();

  // 启用「个股研究」
  await page.locator('[data-testid="wb-plugin-tab-技能"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-enable-stock-research"]').click();
  await page.waitForTimeout(900);
  report.libAfterEnable = readLib();

  // 启用项应出现在输入区的 chip 上
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(800);
  report.enabledChips = await page.$$eval(".wb-composer-chip", (els) => els.map((e) => e.textContent.trim()));
  report.chipCount = await page.locator('[data-testid="wb-enabled-chips"]').count();

  // 技能选择器里能看到装过的条目
  await page.locator('[data-testid="wb-skills"]').click();
  await page.waitForTimeout(600);
  report.skillPopItems = await page.$$eval('[data-testid^="wb-skill-toggle-"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, " ").trim()),
  );
  await page.locator('[data-testid="wb-skills"]').click();
  await page.waitForTimeout(400);

  /* ---------- 11.8 项目分组 ---------- */
  // 先建两个任务，才能谈分组
  for (const text of ["整理本周工作要点", "写一份竞品分析"]) {
    await page.locator('[data-testid="wb-composer-input"]').fill(text);
    await page.locator('[data-testid="wb-send"]').click();
    await page.waitForTimeout(2500);
  }

  await page.locator('[data-testid="wb-project-new"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-project-name"]').fill("市场调研");
  await page.locator('[data-testid="wb-project-name"]').press("Enter");
  await page.waitForTimeout(1000);

  report.projects = await page.$$eval('[data-testid^="wb-project-"]', (els) =>
    els.map((e) => ({ id: e.getAttribute("data-testid"), text: e.textContent.replace(/\s+/g, " ").trim() })),
  );
  report.libAfterProject = readLib();

  // 归入项目 + 置顶：产品把左栏行的内联控件换成了悬停 ⋯ 菜单，这里跟着走菜单
  const openRowMenu = async () => {
    const row = page.locator('[data-testid^="wb-recent-"]').first();
    await row.hover();
    await page.waitForTimeout(400);
    await page.locator('[data-testid^="wb-rowmenu-"]').first().click();
    await page.waitForTimeout(700);
  };

  /*
   * ⚠️ **置顶必须在归入之前**：被归入项目的那条线程会从「最近」里搬走，
   *    搬走之后再想悬停「最近」行就没有元素可点了（2026-10-14 实测：
   *    第二次 `openRowMenu()` 永远等不到 `wb-recent-*`）。
   */
  await openRowMenu();
  report.rowMenuItems = await page.$$eval('[data-testid^="wb-navmenu-"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, "")),
  );
  await page.locator('[data-testid="wb-navmenu-置顶"]').click();
  await page.waitForTimeout(1000);
  report.libAfterPin = readLib();

  report.recentRowsBeforeAssign = await page.locator('[data-testid^="wb-recent-"]').count();

  // 归入项目（有项目时，菜单里会有「归入「市场调研」」）
  await openRowMenu();
  const assignItem = report.rowMenuItems.find((t) => t.includes("归入"));
  if (assignItem) {
    await page.locator('[data-testid*="归入"]').first().click();
    await page.waitForTimeout(1000);
  }
  report.libAfterAssign = readLib();
  report.recentRowsAfterAssign = await page.locator('[data-testid^="wb-recent-"]').count();

  await shot(page, ".verify/shots-final/wb-15-library.png");

  /* ---------- 重启：库应完整保留 ---------- */
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2500));

  ({ child, browser, page, getLog } = await launch(9311));
  await page.waitForTimeout(1500);
  report.afterRestart = {
    installedCount: await page.locator('[data-testid="wb-installed-count"]').textContent().catch(() => null),
    projects: await page.$$eval('[data-testid^="wb-project-"]', (els) =>
      els.map((e) => e.textContent.replace(/\s+/g, " ").trim()),
    ),
    pinnedRows: await page.locator('[data-testid^="wb-pinned-"]').count(),
    enabledChips: await page.$$eval(".wb-composer-chip", (els) => els.map((e) => e.textContent.trim())),
  };
} catch (e) {
  report.error = String(e).split("\n")[0];
  console.error("[诊断] 应用输出尾部：\n" + (getLog() ?? "(空)").slice(-1200));
} finally {
  console.log(JSON.stringify(report, null, 2));
  try {
    await browser?.close();
  } catch {
    /* 已经没了就算了 */
  }
  try {
    child?.kill();
  } catch {
    /* 同上 */
  }
}
