import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 云盘接真实目录的验收（阶段 11.5）。
 *
 * 做法：先在数据目录里**预置真实文件**（云盘本体 + 产物目录 + 导出目录），
 * 再启动应用，断言列表里出现的正是这些文件、类型判对、三个 tab 行为对、
 * 收藏与删除真的生效。
 *
 * 关键点：**不能只看界面有没有行** —— 那跟原来的假数据看不出区别。
 * 所以断言要落到"文件名、大小、类型"这些只有读真目录才对得上的字段。
 */
const DATA = "D:/DoubaoWorkClone/.verify/drive-data";
fs.rmSync(DATA, { recursive: true, force: true });

// 预置三个来源目录，文件名刻意跨类目
const seed = [
  ["drive", "季度总结.md", "# 季度总结\n正文若干\n"],
  ["drive", "销售数据.xlsx", "PK\u0003\u0004fake-xlsx-body"],
  ["drive", "路演稿.pptx", "PK\u0003\u0004fake-pptx-body"],
  ["drive", "封面图.png", "fake-png"],
  ["drive", "未命名文件.xyz", "unknown-kind"],
  ["artifacts", "产品周报（本周）.md", "# 产品周报\n"],
  ["artifacts", "本周工作汇报.docx", "PK\u0003\u0004fake-docx"],
  ["exports", "画布-2026.png", "fake-png-export"],
];
for (const [dir, name, body] of seed) {
  const target = path.join(DATA, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, name), body, "utf8");
}
// 一个不该出现的隐藏文件
fs.writeFileSync(path.join(DATA, "drive", ".DS_Store"), "junk");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9550"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9550");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};
const shots = "D:/DoubaoWorkClone/.verify/shots-final";

await page.locator('[data-testid="wb-nav-cloud"]').click();
await page.waitForTimeout(2500);

report.count = await page.locator('[data-testid="wb-cloud-count"]').textContent();
report.rows = await page.$$eval(".wb-tr:not(.wb-th)", (els) =>
  els.map((e) => ({
    name: e.querySelector(".wb-td-link")?.textContent ?? "",
    kind: e.querySelector(".wb-kind")?.textContent ?? "",
    size: e.querySelector(".wb-td-num")?.textContent ?? "",
    from: e.querySelector(".wb-td-from")?.textContent ?? "",
  })),
);
report.headers = await page.$$eval(".wb-th span", (els) => els.map((e) => e.textContent.trim()));

// 隐藏文件不该出现
report.hiddenLeaked = report.rows.some((r) => r.name.startsWith("."));

// 三个 tab
await page.locator('[data-testid="wb-cloud-tab-mine"]').click();
await page.waitForTimeout(600);
report.mineOrder = await page.$$eval(".wb-td-link", (els) => els.map((e) => e.textContent));
await page.locator('[data-testid="wb-cloud-tab-starred"]').click();
await page.waitForTimeout(600);
report.starredBefore = await page.locator('[data-testid="wb-cloud-empty"]').count();

// 收藏两个
await page.locator('[data-testid="wb-cloud-tab-recent"]').click();
await page.waitForTimeout(500);
await page.locator('[data-testid="wb-star-季度总结.md"]').click();
await page.waitForTimeout(200);
await page.locator('[data-testid="wb-star-封面图.png"]').click();
await page.waitForTimeout(400);
await page.locator('[data-testid="wb-cloud-tab-starred"]').click();
await page.waitForTimeout(600);
report.starredList = await page.$$eval(".wb-td-link", (els) => els.map((e) => e.textContent));

await page.screenshot({ path: path.join(shots, "wb-13-cloud.png") });

// 「最近」排序：刚改过的排前面 —— 改一个旧文件的 mtime 再刷新
await page.locator('[data-testid="wb-cloud-tab-recent"]').click();
await page.waitForTimeout(400);
const old = path.join(DATA, "drive", "未命名文件.xyz");
const future = new Date(Date.now() + 60_000);
fs.utimesSync(old, future, future);
await page.locator('[data-testid="wb-cloud-refresh"]').click();
await page.waitForTimeout(1500);
report.recentFirst = await page.$eval(".wb-td-link", (e) => e.textContent);

// 删除
await page.locator('[data-testid="wb-del-未命名文件.xyz"]').click();
await page.waitForTimeout(1500);
report.afterDeleteExists = fs.existsSync(old);
report.afterDeleteRows = await page.$$eval(".wb-td-link", (els) => els.length);

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();
