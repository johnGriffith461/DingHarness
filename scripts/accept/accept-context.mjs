import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 11.14 验收：云盘行右键菜单 + 插件「管理」子页。
 *
 * 两项都是从第三遍实机遍历里发现的（`.verify\tour3\`）：
 *   · `04-cloud-row-context.png` —— 七项右键菜单
 *   · `06-plugin-manage.png` —— 面包屑「市场 › 管理」+ 插件/技能/连接器 带计数
 *
 * 菜单里的**每一项都要能点且行为可验证** —— 「创建副本」真复制文件、
 * 「复制链接」真进剪贴板、「删除」真删；另外两项（分享 / 快捷方式）如实标注需要什么。
 */
const DATA = "D:/DoubaoWorkClone/.verify/ctx-data";
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA, "drive"), { recursive: true });
fs.writeFileSync(path.join(DATA, "drive", "季度总结.md"), "# 季度总结\n", "utf8");
fs.writeFileSync(path.join(DATA, "drive", "封面图.png"), "fake", "utf8");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9600"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9600");
const ctx = browser.contexts()[0];
await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
const pages = ctx.pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};
try {
const shots = "D:/DoubaoWorkClone/.verify/shots-final";

/* ---------- 云盘行右键菜单 ---------- */
await page.locator('[data-testid="wb-nav-cloud"]').click();
await page.waitForTimeout(2500);

await page.locator('[data-testid="wb-file-季度总结.md"]').click({ button: "right" });
await page.waitForTimeout(700);
report.menuOpened = await page.locator('[data-testid="wb-drive-menu"]').count();
report.menuItems = await page.$$eval(".wb-ctx-item", (els) =>
  els.map((e) => ({ label: e.textContent.replace(/[^\u4e00-\u9fa5]/g, ""), disabled: e.disabled })),
);
await page.screenshot({ path: path.join(shots, "wb-19-ctx.png") });

// 复制链接 —— 剪贴板里应是 dshasset://file/...
await page.locator('[data-testid="wb-ctx-复制链接"]').click();
await page.waitForTimeout(800);
report.clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => "(读不到)"));
report.noteAfterCopy = await page.locator('[data-testid="wb-cloud-note"]').textContent().catch(() => null);

// 创建副本 —— 目录里应真的多一个「-副本」文件
await page.locator('[data-testid="wb-file-季度总结.md"]').click({ button: "right" });
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-ctx-创建副本"]').click();
await page.waitForTimeout(1500);
report.duplicateOnDisk = fs.readdirSync(path.join(DATA, "drive")).sort();
report.rowsAfterDuplicate = await page.locator(".wb-tr:not(.wb-th)").count();

// 问问豆包 —— 应调起悬浮窗并带预填问题
await page.locator('[data-testid="wb-file-封面图.png"]').click({ button: "right" });
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-ctx-问问豆包"]').click();
await page.waitForTimeout(2500);
report.floatFromDrive = await page.locator('[data-testid="wb-float"]').count();
report.floatBubble = await page.locator(".wb-float-user-bubble").first().textContent().catch(() => null);
await page.locator('[data-testid="wb-float-close"]').click().catch(() => undefined);
await page.waitForTimeout(600);

// 删除 —— 文件应从磁盘消失
await page.locator('[data-testid="wb-file-季度总结.md"]').click({ button: "right" });
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-ctx-删除"]').click();
await page.waitForTimeout(1500);
report.stillExists = fs.existsSync(path.join(DATA, "drive", "季度总结.md"));
report.remainingOnDisk = fs.readdirSync(path.join(DATA, "drive")).sort();

/* ---------- 插件管理子页 ---------- */
await page.locator('[data-testid="wb-nav-plugins"]').click();
await page.waitForTimeout(1200);

// 先装一个插件与一个技能
await page.locator('[data-testid="wb-plugin-tab-技能"]').click();
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-install-stock-research"]').click();
await page.waitForTimeout(700);
await page.locator('[data-testid="wb-plugin-tab-插件"]').click();
await page.waitForTimeout(600);
await page.locator('[data-testid="wb-install-feishu"]').click();
await page.waitForTimeout(900);

await page.locator('[data-testid="wb-plugin-manage"]').click();
await page.waitForTimeout(1000);
report.manageOpened = await page.locator('[data-testid="wb-page-plugins-manage"]').count();
report.crumb = await page.locator(".wb-crumb").textContent().catch(() => null);
report.manageTabs = await page.$$eval(".wb-manage-tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, "")));
report.pluginTabItems = await page.$$eval('[data-testid^="wb-managed-"]', (els) =>
  els.map((e) => e.querySelector("b")?.textContent ?? ""),
);
await page.locator('[data-testid="wb-manage-tab-技能"]').click();
await page.waitForTimeout(700);
report.skillTabItems = await page.$$eval('[data-testid^="wb-managed-"]', (els) =>
  els.map((e) => e.querySelector("b")?.textContent ?? ""),
);
await page.locator('[data-testid="wb-manage-tab-连接器"]').click();
await page.waitForTimeout(700);
report.connectorEmpty = await page.locator('[data-testid="wb-manage-empty"]').textContent().catch(() => null);

await page.screenshot({ path: path.join(shots, "wb-20-manage.png") });

// 面包屑回市场
await page.locator('[data-testid="wb-crumb-market"]').click();
await page.waitForTimeout(800);
report.backToMarket = await page.locator('[data-testid="wb-page-plugins"]').count();

// 移除一个（管理页的移除 = 卸载）
await page.locator('[data-testid="wb-plugin-manage"]').click();
await page.waitForTimeout(800);
// 进管理应回到默认 tab（插件），而不是记住上次停的「连接器」
report.manageTabOnReentry = await page.locator('[data-testid="wb-manage-tab-插件"]').getAttribute("class");
await page.locator('[data-testid="wb-remove-feishu"]').click();
await page.waitForTimeout(1200);
const lib = JSON.parse(fs.readFileSync(path.join(DATA, "library.json"), "utf8"));
report.installedAfterRemove = lib.installed;

} finally {
  // 失败也把已有结果打出来 —— 一条晚失败不该丢掉全部证据
  console.log(JSON.stringify(report, null, 2));
}
await browser.close();
child.kill();
