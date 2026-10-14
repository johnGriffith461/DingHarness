import { chromium } from "playwright";
import fs from "node:fs";
import { openApp, shot, verdict } from "./harness.mjs";

/**
 * 左栏「项目」那一行：建 / 改名 / 归入 / 移出 / 删（2026-10-14）。
 *
 * ## 为什么单开一条
 * `wb-project-rename-*` / `wb-project-del-*` / `wb-project-member-*` 三个 testid
 * 在 `src/` × `scripts/accept/` 的交叉里**零覆盖**（§208 那份清单）。
 * 而这三个"小按钮"原来还是**可点的 `<span>`** —— 键盘够不着、读屏念不出，
 * 而且用 `✎ × −` 这几个字符当图标（与全站的 lucide 不一致）。这一轮把它们改成真按钮，
 * 于是更需要一条验收盯着它们的**后果**（不是"元素在不在"）。
 *
 * ## 免模型
 * 建任务那一步会调模型 → 用**空凭据文件**让它注定失败（`.verify/projects-keys.yaml`），
 * 任务照样建出来（这一步只需要"有个任务能归进项目"）。
 */
const DATA = "D:/DoubaoWorkClone/.verify/projects-data";
fs.rmSync(DATA, { recursive: true, force: true });
const EMPTY_KEYS = "D:/DoubaoWorkClone/.verify/projects-keys.yaml";
fs.writeFileSync(EMPTY_KEYS, "refs:\n", "utf8");

const { browser, page, child } = await openApp(chromium, {
  port: 9571,
  dataDir: DATA,
  extraEnv: { DSH_CREDENTIALS_FILE: EMPTY_KEYS },
  timeoutMs: 40000,
});

const report = {};
try {
  /* ① 建一个项目（真输入框 + Enter） */
  report.step = "建项目";
  await page.locator('[data-testid="wb-project-new"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="wb-project-name"]').fill("验收项目");
  await page.locator('[data-testid="wb-project-name"]').press("Enter");
  await page.waitForTimeout(800);
  /*
   * ⚠️ 选择器要**排除那两个名字相近的**：`wb-project-new`（＋ 建项目那颗按钮）
   * 与 `wb-project-name`（输入框）。第一版用 `[data-testid^="wb-project-"]` 抓到了"＋"，
   * 于是后面 rename/del 全找错（projectId 变成了 "new"）。
   */
  const rowSel = '[data-testid^="wb-project-"]:not([data-testid="wb-project-new"]):not([data-testid="wb-project-name"])';
  report.projectRow = await page.locator(rowSel).first().textContent().catch(() => null);
  const projectTestid = await page.locator(rowSel).first().getAttribute("data-testid");
  report.projectId = (projectTestid ?? "").replace("wb-project-", "");
  report.zeroMembers = await page.locator(".wb-nav-count").first().textContent().catch(() => null);

  /* ② 改名：`window.prompt` 是原生对话框（CDP 抓不到），换成固定返回值 —— 测试接缝 */
  report.step = "改名";
  await page.evaluate(() => {
    window.prompt = () => "验收项目（改名后）";
  });
  await page.locator(`[data-testid="wb-project-rename-${report.projectId}"]`).click();
  await page.waitForTimeout(800);
  report.renamedRow = await page.locator(`[data-testid="wb-project-${report.projectId}"]`).textContent().catch(() => null);

  /* ③ 建一个任务（注定失败，但任务会真的建出来），再用它的 ⋯ 菜单归入项目 */
  report.step = "建任务";
  await page.locator('[data-testid="wb-composer-input"]').fill("给项目验收用的一句话");
  await page.locator('[data-testid="wb-send"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="wb-send-stop"]'), { timeout: 25000 });
  await page.waitForTimeout(1200);
  report.step = "把它归入项目";
  /* 任务行上的 ⋯ → 菜单里那条「归入「验收项目（改名后）」」 */
  const rowMore = page.locator('[data-testid="wb-nav"] .wb-nav-row').first();
  await rowMore.hover();
  await page.waitForTimeout(300);
  /* 悬停露出的 ⋯ 的类名是 `.wb-nav-rowmore`（样式里那一处就是它） */
  const moreBtn = page.locator('[data-testid="wb-nav"] .wb-nav-rowmore').first();
  await moreBtn.click({ force: true });
  await page.waitForTimeout(600);
  report.menuOpened = await page.locator('[data-testid="wb-navmenu"]').count();
  const assignItem = page.locator('[data-testid="wb-navmenu"] .wb-ctx-item', { hasText: "归入" }).first();
  report.assignLabel = await assignItem.textContent().catch(() => null);
  if (await assignItem.count()) {
    await assignItem.click();
    await page.waitForTimeout(900);
  }
  report.countAfterAssign = await page.locator(".wb-nav-count").first().textContent().catch(() => null);

  /* ④ 展开项目 → 成员行（`wb-project-member-*`）在，点它能开那个任务 */
  report.step = "展开项目看成员";
  /*
   * ⚠️ 项目行**默认就是展开的**（`open = !collapsed.has(id)`）——
   * 我第一版无条件点了一下，反而把它**收起来**了（于是成员行 0 条）。
   * 所以这里只在"没有成员行"时才点。
   */
  if ((await page.locator('[data-testid^="wb-project-member-"]').count()) === 0) {
    await page.locator(`[data-testid="wb-project-${report.projectId}"]`).click();
    await page.waitForTimeout(700);
  }
  report.memberRows = await page.locator('[data-testid^="wb-project-member-"]').count();
  report.memberText = await page.locator('[data-testid^="wb-project-member-"]').first().textContent().catch(() => null);

  /* ⑤ 移出项目（成员行上那颗小按钮）：计数回到 0 */
  report.step = "移出项目";
  await page.locator('[data-testid^="wb-project-member-"] button[aria-label="移出项目"]').first().click();
  await page.waitForTimeout(900);
  report.countAfterRemove = await page.locator(".wb-nav-count").first().textContent().catch(() => null);

  await shot(page, "D:/DoubaoWorkClone/.verify/shots-final/projects.png");

  /* ⑥ 删项目：项目没了，**任务还在**（那一行的说明就是这句） */
  report.step = "删项目";
  await page.locator(`[data-testid="wb-project-del-${report.projectId}"]`).click();
  await page.waitForTimeout(900);
  report.projectGone = (await page.locator(`[data-testid="wb-project-${report.projectId}"]`).count()) === 0;
  report.tasksLeft = await page.locator('[data-testid="wb-nav"] .wb-nav-row').count();
} catch (error) {
  report.error = `在「${report.step ?? "未知"}」这一步失败：${String(error).split(String.fromCharCode(10))[0]}`;
} finally {
  console.log(JSON.stringify(report, null, 2));

  const bad = [];
  if (report.error) bad.push(`异常：${String(report.error).slice(0, 200)}`);

  /* ① 建出来了，且计数是 0 */
  if (!String(report.projectRow ?? "").includes("验收项目")) bad.push(`建项目后列表里没有它：${JSON.stringify(report.projectRow)}`);
  if (String(report.zeroMembers ?? "").trim() !== "0") bad.push(`新项目的任务计数不是 0：${JSON.stringify(report.zeroMembers)}`);

  /* ② 改名落到界面上 */
  if (!String(report.renamedRow ?? "").includes("改名后")) bad.push(`改名没生效：${JSON.stringify(report.renamedRow)}`);

  /* ③ 归入之后计数变 1 */
  if (!report.menuOpened) bad.push("任务行的 ⋯ 菜单打不开（那一步没做成，归入断言不算数）");
  if (!String(report.assignLabel ?? "").includes("归入")) bad.push(`菜单里没有「归入」那一条：${JSON.stringify(report.assignLabel)}`);
  if (String(report.countAfterAssign ?? "").trim() !== "1") {
    bad.push(`归入项目后计数应变成 1，实际 ${JSON.stringify(report.countAfterAssign)}`);
  }

  /* ④ 展开能看到成员行 */
  if ((report.memberRows ?? 0) < 1) bad.push("展开项目后没有成员行（wb-project-member-*）");

  /* ⑤ 移出之后计数回 0 */
  if (String(report.countAfterRemove ?? "").trim() !== "0") {
    bad.push(`移出项目后计数应回到 0，实际 ${JSON.stringify(report.countAfterRemove)}`);
  }

  /* ⑥ 删项目：项目没了，但**任务不能被删**（那一行自己写明了"里面的任务不会被删"） */
  if (!report.projectGone) bad.push("删项目之后它还在列表里");
  if ((report.tasksLeft ?? 0) < 1) bad.push("⭐ 删项目把里面的任务也删了（说好不删的）");

  verdict(bad, "项目行成立：建 / 改名落到界面 / 归入后计数 1 / 成员行能展开 / 移出回 0 / 删项目不删任务");

  await browser.close().catch(() => undefined);
  child?.kill();
  process.exit(process.exitCode ?? 0);
}
