import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readStoreFile } from "./harness.mjs";

/**
 * 11.34 验收：添加自定义能力，并确认它**真的走到任务侧**。
 *
 * 上一轮我把这条的关键点写清楚了：光能加进库不算数，
 * **`findItemIn` 查得到它**才算数 —— 任务侧取名字走的就是这一个查询。
 * 查不到的话，条目进了 `enabled` 也不会出现在任务的系统提示词里，等于装了没用。
 *
 * 所以断言分两半：
 *   前半：加 → 落盘 → 自动装上并启用；
 *   后半：**同一个 `findItemIn` 的产物**在输入区露出来（启用 chip + 技能选择器）——
 *         这两处与 `enabledBlock()` 走的是同一个函数、同一份 lib。
 */
const DATA = "D:/DoubaoWorkClone/.verify/custom-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9740"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9740");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1800);

const report = {};
try {
  await page.locator('[data-testid="wb-nav-plugins"]').click();
  await page.waitForTimeout(1200);

  await page.locator('[data-testid="wb-plugin-add"]').click();
  await page.waitForTimeout(700);
  report.formOpened = await page.locator('[data-testid="wb-add-form"]').count();

  // 空名字应被拦
  await page.locator('[data-testid="wb-add-save"]').click();
  await page.waitForTimeout(600);
  report.errorOnEmpty = await page.locator('[data-testid="wb-add-error"]').textContent();

  // 填好加一条
  await page.locator('[data-testid="wb-add-name"]').fill("查股价");
  await page.locator('[data-testid="wb-add-hint"]').fill("按股票代码查当前价格与涨跌幅");
  await page.locator('[data-testid="wb-add-type"]').selectOption("skill");
  await page.locator('[data-testid="wb-add-save"]').click();
  await page.waitForTimeout(1500);
  report.formClosedAfterSave = (await page.locator('[data-testid="wb-add-form"]').count()) === 0;

  const lib = readStoreFile(path.join(DATA, "library.json"));
  report.custom = lib.custom;
  report.autoInstalled = lib.installed.includes(lib.custom[0]?.id);
  report.autoEnabled = lib.enabled.includes(lib.custom[0]?.id);

  // 同名的应被拦
  await page.locator('[data-testid="wb-plugin-add"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="wb-add-name"]').fill("查股价");
  await page.locator('[data-testid="wb-add-hint"]').fill("重复的");
  await page.locator('[data-testid="wb-add-save"]').click();
  await page.waitForTimeout(700);
  report.errorOnDuplicate = await page.locator('[data-testid="wb-add-error"]').textContent();
  await page.locator('[data-testid="wb-add-cancel"]').click();
  await page.waitForTimeout(500);

  /* ---------- 管理子页：自定义条目要看得到、计数要对 ---------- */
  await page.locator('[data-testid="wb-plugin-manage"]').click();
  await page.waitForTimeout(1200);
  report.manageTabs = await page.$$eval(".wb-manage-tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, "")));
  await page.locator('[data-testid="wb-manage-tab-技能"]').click();
  await page.waitForTimeout(800);
  report.manageSkillItems = await page.$$eval('[data-testid^="wb-managed-"]', (els) =>
    els.map((e) => e.querySelector("b")?.textContent ?? ""),
  );
  report.manageHasCustom = (report.manageSkillItems ?? []).some((t) => t.includes("查股价"));

  /* ---------- 关键：它有没有走到任务侧 ---------- */
  await page.locator('[data-testid="wb-crumb-market"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="wb-nav-home"]').click();
  await page.waitForTimeout(1200);
  report.enabledChips = await page.$$eval(".wb-composer-chip", (els) => els.map((e) => e.textContent.trim()));
  report.chipHasCustom = (report.enabledChips ?? []).some((t) => t.includes("查股价"));

  await page.locator('[data-testid="wb-skills"]').click();
  await page.waitForTimeout(700);
  report.skillPopHasCustom = await page.locator('[data-testid="wb-skill-toggle-"]').count();
  report.pickerItems = await page.$$eval('[data-testid^="wb-skill-toggle-"]', (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, " ").trim()),
  );
  report.pickerHasCustom = (report.pickerItems ?? []).some((t) => t.includes("查股价"));

  /* ---------- 重启后仍在（落盘） ---------- */
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2500));
  const c2 = spawn(
    "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
    [".", "--remote-debugging-port=9751"],
    { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
  );
  await new Promise((r) => setTimeout(r, 14000));
  const b2 = await chromium.connectOverCDP("http://127.0.0.1:9751");
  const p2 = b2.contexts()[0].pages().find((p) => !p.url().startsWith("devtools://"));
  await p2.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
  await p2.waitForTimeout(2000);
  report.afterRestartChips = await p2.$$eval(".wb-composer-chip", (els) => els.map((e) => e.textContent.trim()));
  report.afterRestartInstalled = await p2.locator('[data-testid="wb-installed-count"]').textContent().catch(() => null);
  await b2.close();
  c2.kill();
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();
}
