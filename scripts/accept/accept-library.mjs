import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, pickPort, readStoreFile, shot, waitForPort } from "./harness.mjs";

/**
 * 插件安装（11.7）与项目分组（11.8）的验收。
 *
 * **验证分工要说清楚**：
 *   · 「装/启用/项目/置顶 能持久化」→ 端到端（磁盘上真写、重启真还在）
 *   · 「启用项会进任务的系统提示词」→ 单测（`library.test.ts` 的 enabledPromptBlock 三条）
 * 后一条没在端到端里做，是因为调试出口是 DEV-only，构建版拿不到；
 * 硬用模型回复去反推会变成不稳定的断言。所以这里只验到"启用项进了界面与库"。
 */
const DATA = "D:/DoubaoWorkClone/.verify/lib-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const EXE = "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe";

async function launch(port) {
  /* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
  port = await pickPort([port]);
  const child = spawn(EXE, [".", `--remote-debugging-port=${port}`], {
    cwd: "D:/DoubaoWorkClone",
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  /* 固定等 8 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(port, 40000);
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${port}`);
  const pages = browser.contexts()[0].pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { child, browser, page };
}

const report = {};
const libFile = path.join(DATA, "library.json");
const readLib = () => (fs.existsSync(libFile) ? readStoreFile(libFile) : null);

let { child, browser, page } = await launch(9570);

/* ---------- 11.7 插件安装 ---------- */
await page.locator('[data-testid="wb-nav-plugins"]').click();
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

await openRowMenu();
report.rowMenuItems = await page.$$eval('[data-testid^="wb-navmenu-"]', (els) =>
  els.map((e) => e.textContent.replace(/\s+/g, "")),
);
// 有项目时，菜单里会有「归入「市场调研」」
const assignItem = report.rowMenuItems.find((t) => t.includes("归入"));
if (assignItem) {
  await page.locator('[data-testid*="归入"]').first().click();
  await page.waitForTimeout(1000);
}
report.libAfterAssign = readLib();

// 置顶
await openRowMenu();
await page.locator('[data-testid="wb-navmenu-置顶"]').click();
await page.waitForTimeout(1000);
report.libAfterPin = readLib();

await shot(page, "D:/DoubaoWorkClone/.verify/shots-final/wb-15-library.png");

/* ---------- 重启：库应完整保留 ---------- */
await browser.close();
child.kill();
await new Promise((r) => setTimeout(r, 2500));

({ child, browser, page } = await launch(9571));
await page.waitForTimeout(1500);
report.afterRestart = {
  installedCount: await page.locator('[data-testid="wb-installed-count"]').textContent().catch(() => null),
  projects: await page.$$eval('[data-testid^="wb-project-"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, " ").trim()),
  ),
  pinnedRows: await page.locator('[data-testid^="wb-pinned-"]').count(),
  enabledChips: await page.$$eval(".wb-composer-chip", (els) => els.map((e) => e.textContent.trim())),
};

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();
