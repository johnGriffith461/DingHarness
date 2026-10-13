import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { shot, verdict } from "./harness.mjs";

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

await shot(page, path.join(shots, "wb-13-cloud.png"));

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
/*
 * ⚠️ 删除**要走确认框**（`CloudPage.tsx:402` 点的是 `setConfirmDel`）——
 * 脚本原来点完就断言文件没了，于是永远红。产品是对的：删文件不可逆，必须有二次确认。
 * 这里顺手把"确认框真的出现"也记下来。
 */
await page.locator('[data-testid="wb-del-未命名文件.xyz"]').click();
await page.waitForTimeout(900);
report.deleteConfirmShown = await page.locator('[data-testid="wb-cloud-confirm"]').count();
report.deleteConfirmNames = await page.locator(".wb-cloud-dialog-sub").textContent().catch(() => null);
await page.locator('[data-testid="wb-cloud-confirm-ok"]').click();
await page.waitForTimeout(1500);
report.afterDeleteExists = fs.existsSync(old);
report.afterDeleteRows = await page.$$eval(".wb-td-link", (els) => els.length);

/*
 * ── 判定（2026-10-14 补）────────────────────────────────────────────
 *
 * 这条脚本自己写着"不能只看界面有没有行 —— 那跟原来的假数据看不出区别"，
 * 但它**一条判定都没有**：打报告就退。于是"接真目录"这件事坏掉（退回假数据、
 * 隐藏文件泄漏、收藏不落盘、删除只改界面不删文件），它永远绿。
 */
const bad = [];
const rows = report.rows ?? [];
const names = rows.map((r) => r.name);

/* ① 列表 = 真目录里那 8 个（少的算漏，多的算假数据或泄漏） */
const expected = seed.map(([, name]) => name);
const missing = expected.filter((n) => !names.includes(n));
if (missing.length) bad.push(`真目录里有但列表里没有：${missing.join(" / ")}`);
if (report.hiddenLeaked) bad.push("⭐ 隐藏文件（.DS_Store）漏进了列表");
if (rows.length !== expected.length) bad.push(`行数 ${rows.length} ≠ 预置文件数 ${expected.length}`);

/* ② 类型判对：靠扩展名，不靠内容猜 */
const kindOf = (n) => rows.find((r) => r.name === n)?.kind ?? "";
if (!kindOf("季度总结.md").includes("文档")) bad.push(`.md 的类型是 "${kindOf("季度总结.md")}"（应为文档）`);
if (!kindOf("销售数据.xlsx").includes("表格")) bad.push(`.xlsx 的类型是 "${kindOf("销售数据.xlsx")}"（应为表格）`);
if (!kindOf("封面图.png").includes("图片")) bad.push(`.png 的类型是 "${kindOf("封面图.png")}"（应为图片）`);
if (!kindOf("未命名文件.xyz").includes("其他")) bad.push(`未知后缀的类型是 "${kindOf("未命名文件.xyz")}"（应为其他）`);

/* ③ 大小不是占位符：预置内容长度已知，至少不能全是 0 */
if (rows.every((r) => /^0\s*B$/.test(r.size ?? ""))) bad.push("所有文件大小都是 0 B（没读真实 stat）");

/* ④ 三个 tab 各自成立 */
if ((report.starredBefore ?? 0) === 0) bad.push("一开始「收藏」tab 不是空态（收藏是假的）");
const starred = report.starredList ?? [];
if (!starred.includes("季度总结.md") || !starred.includes("封面图.png")) {
  bad.push(`收藏两个之后收藏夹里是 ${JSON.stringify(starred)}`);
}
if (!String(report.count ?? "").includes(String(expected.length))) {
  bad.push(`计数栏写的是 ${JSON.stringify(report.count)}（应为 ${expected.length}）`);
}

/* ⑤ 「最近」真的按 mtime 排 */
if (report.recentFirst !== "未命名文件.xyz") {
  bad.push(`改了 mtime 之后「最近」的第一行是 ${JSON.stringify(report.recentFirst)}`);
}

/* ⑥ 删除是**真删文件**，不只是从界面拿掉一行 */
if (!report.deleteConfirmShown) bad.push("⭐ 点删除没有确认框（不可逆动作没有二次确认）");
if (!report.deleteConfirmNames?.includes("未命名文件")) bad.push(`确认框里没写清删的是哪个文件：${JSON.stringify(report.deleteConfirmNames)}`);
if (report.afterDeleteExists) bad.push("⭐ 确认删除后磁盘上的文件还在（假删除）");
if ((report.afterDeleteRows ?? 99) >= rows.length) bad.push("删除后行数没减少");

verdict(bad, "云盘接真目录成立：列表=真文件 / 类型与大小对得上 / 隐藏文件不漏 / 收藏空态→两个 / 最近按 mtime / 删除真删盘");

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();
