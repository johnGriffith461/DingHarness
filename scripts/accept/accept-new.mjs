import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 11.24 验收：云盘「＋新建」真建文件 + 首页推荐卡真的会变。
 *
 * 两处原来都是"看起来有、其实没有"：
 *   · 「＋新建」点了只弹一句提示（**死按钮**）
 *   · 推荐卡写死四条 —— 而实机三次遍历看到三组不同的（现在有池子）
 */
const DATA = "D:/DoubaoWorkClone/.verify/newdata";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9650"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9650");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};

/*
 * `window.prompt` 是**原生对话框**，在 CDP 连线下 `page.on("dialog")` 抓不到 ——
 * 它一弹出就挂住，onClick 后面的代码根本不执行（第一次跑就是这个结果：
 * 云盘目录都没建出来）。所以直接把 prompt 换成一个返回固定值的函数。
 * 这是测试用的接缝，不是产品代码的改动。
 */
const stubPrompt = (value) =>
  page.evaluate((v) => {
    window.prompt = () => v;
  }, value);

try {
  /* ---------- 首页推荐卡的轮换 ---------- */
  const sets = [];
  for (let i = 0; i < 6; i += 1) {
    // 离开首页再回来，触发重抽
    await page.locator('[data-testid="wb-nav-plugins"]').click();
    await page.waitForTimeout(500);
    await page.locator('[data-testid="wb-nav-home"]').click();
    await page.waitForTimeout(700);
    const batch = await page.$$eval('[data-testid^="wb-suggestion-"]', (els) => els.map((e) => e.textContent.trim()));
    sets.push(batch);
  }
  report.batchCount = sets[0]?.length ?? 0;
  report.distinctBatches = new Set(sets.map((b) => b.join("|"))).size;
  report.sampleBatches = [sets[0], sets[1]];
  // 同一批里不该有重复
  report.anyDuplicateWithinBatch = sets.some((b) => new Set(b).size !== b.length);

  /* ---------- 云盘「＋新建」---------- */
  const driveDir = path.join(DATA, "drive");
  const before = fs.existsSync(driveDir) ? fs.readdirSync(driveDir).length : 0;

  await stubPrompt("会议纪要");
  await page.locator('[data-testid="wb-nav-cloud"]').click();
  await page.waitForTimeout(2000);
  await page.locator('[data-testid="wb-cloud-new"]').click();
  // 新建是菜单（新建文档 / 新建文件夹 / 新建 PPT）—— §157 按证据改的，这里补一次点击
  await page.locator('[data-testid="wb-cloud-new-doc"]').click();
  await page.waitForTimeout(2500);

  const files = fs.existsSync(driveDir) ? fs.readdirSync(driveDir) : [];
  report.driveBefore = before;
  report.driveAfter = files.length;
  report.createdFiles = files;
  report.createdContent = files.includes("会议纪要.md") ? fs.readFileSync(path.join(driveDir, "会议纪要.md"), "utf8") : null;
  report.newNote = await page.locator('[data-testid="wb-cloud-note"]').textContent().catch(() => null);
  report.rowCountAfter = await page.locator(".wb-tr:not(.wb-th)").count();
  report.rowVisible = await page.locator('[data-testid="wb-file-会议纪要.md"]').count();

  // 重名 → 自动加序号（不能覆盖已有文件）
  await stubPrompt("会议纪要");
  await page.locator('[data-testid="wb-cloud-new"]').click();
  // 新建是菜单（新建文档 / 新建文件夹 / 新建 PPT）—— §157 按证据改的，这里补一次点击
  await page.locator('[data-testid="wb-cloud-new-doc"]').click();
  await page.waitForTimeout(2500);
  report.afterSecondCreate = fs.readdirSync(driveDir).sort();

  // 非法名字（带路径分隔符）应被拒
  await stubPrompt("../../逃逸.md");
  await page.locator('[data-testid="wb-cloud-new"]').click();
  // 新建是菜单（新建文档 / 新建文件夹 / 新建 PPT）—— §157 按证据改的，这里补一次点击
  await page.locator('[data-testid="wb-cloud-new-doc"]').click();
  await page.waitForTimeout(2000);
  report.afterIllegalName = fs.readdirSync(driveDir).sort();
  report.illegalNote = await page.locator('[data-testid="wb-cloud-note"]').textContent().catch(() => null);
  report.escapedOutside = fs.existsSync(path.join(DATA, "逃逸.md")) || fs.existsSync(path.join(DATA, "..", "逃逸.md"));
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => undefined);
  child.kill();
}
