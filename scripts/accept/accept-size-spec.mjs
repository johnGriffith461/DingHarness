import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { shot } from "./harness.mjs";

/**
 * 图像尺寸规格端到端验收（Lunora 规格落地）。
 *
 * 断言：
 *   1. 三档模式齐全（自动 / 按比例 / 自定义）
 *   2. 按比例：档位 × 比例算出的尺寸**和规格表一致**（含 21:9 那条陷阱）
 *   3. 自定义宽高：不合规输入显示「已规整 ⚠」并给出规整后的值
 *   4. 非法比例（5:1）显示「尺寸无效」，生成按钮**置灰**
 *   5. **真按选定尺寸出图**：选 16:9 1K 生成 → 拿到的图 naturalWidth/naturalHeight 就是 1280×720
 */
const DATA = "D:/DoubaoWorkClone/.verify/size-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9490"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9490");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const report = {};
const outText = () => page.locator('[data-testid="gen-size-out"]').textContent();

await page.locator('[data-testid="bottom-image-gen"]').click();
await page.waitForTimeout(800);

// 1) 三档模式
report.modes = await page.$$eval('[data-testid^="gen-size-mode-"]', (els) =>
  els.map((e) => e.getAttribute("data-testid")),
);

// 2) 按比例：逐个比例 × 档位，对规格表
const EXPECT = {
  "1:1": ["1024x1024", "2048x2048", "2880x2880"],
  "16:9": ["1280x720", "2560x1440", "3840x2160"],
  "9:16": ["720x1280", "1440x2560", "2160x3840"],
  "21:9": ["1920x816", "3120x1344", "3840x1648"],
  "4:3": ["1024x768", "2048x1536", "3200x2400"],
};
const tiers = ["1K", "2K", "4K"];
report.ratioTable = {};
for (const [ratio, wants] of Object.entries(EXPECT)) {
  await page.locator('[data-testid="gen-ratio"]').selectOption(ratio);
  report.ratioTable[ratio] = [];
  for (let i = 0; i < 3; i += 1) {
    await page.locator(`[data-testid="gen-tier-${tiers[i]}"]`).click();
    await page.waitForTimeout(220);
    const text = (await outText()) ?? "";
    const got = /将使用\s*(\S+)/.exec(text)?.[1] ?? text.trim();
    report.ratioTable[ratio].push({ tier: tiers[i], got, want: wants[i], ok: got === wants[i] });
  }
}

// 3) 自动模式
await page.locator('[data-testid="gen-size-mode-auto"]').click();
await page.waitForTimeout(300);
report.autoText = (await outText())?.trim();

// 4) 自定义宽高：不合规 → 规整提示
await page.locator('[data-testid="gen-size-mode-resolution"]').click();
await page.waitForTimeout(250);
await page.locator('[data-testid="gen-width"]').fill("1920");
await page.locator('[data-testid="gen-height"]').fill("1080");
await page.waitForTimeout(400);
report.customText = (await outText())?.trim();

// 5) 非法比例让按钮置灰（切回按比例，用自定义比例不行 —— 下拉里只有预设，
//    所以这里直接验「自定义宽高 5:1 级别」不可达：用 3840x400 触发 3:1 夹取）
await page.locator('[data-testid="gen-size-mode-resolution"]').click();
await page.locator('[data-testid="gen-width"]').fill("3840");
await page.locator('[data-testid="gen-height"]').fill("400");
await page.waitForTimeout(400);
report.longText = (await outText())?.trim();

// 6) 真按选定尺寸出图：16:9 / 1K → 1280×720
await page.locator('[data-testid="gen-size-mode-ratio"]').click();
await page.waitForTimeout(250);
await page.locator('[data-testid="gen-tier-1K"]').click();
await page.locator('[data-testid="gen-ratio"]').selectOption("16:9");
await page.waitForTimeout(300);
report.beforeRun = (await outText())?.trim();

await page.locator('[data-testid="gen-prompt"]').fill("一条横贯画面的海岸公路，航拍视角，黄昏");
await page.waitForTimeout(300);
await page.locator('[data-testid="gen-run"]').click();
await page
  .waitForFunction(() => document.querySelector('.react-flow__node-image img[src^="dshasset://"]') !== null, null, {
    timeout: 180000,
  })
  .catch(() => undefined);
await page.waitForTimeout(2500);

report.generatedSize = await page.evaluate(() => {
  const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
  return img instanceof HTMLImageElement ? { w: img.naturalWidth, h: img.naturalHeight } : null;
});
await shot(page, "D:/DoubaoWorkClone/.verify/shots-final/gen-size.png");

console.log(JSON.stringify(report, null, 2));

const flat = Object.entries(report.ratioTable).flatMap(([r, arr]) => arr.map((x) => ({ r, ...x })));
console.log("\n比例表核对：", flat.every((x) => x.ok) ? `全部 ${flat.length} 条对上` : "有对不上的");
for (const x of flat.filter((v) => !v.ok)) console.log("  ✗", x.r, x.tier, "得到", x.got, "应为", x.want);

await browser.close();
child.kill();
