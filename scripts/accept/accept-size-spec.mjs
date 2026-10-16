import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, failOnMarks, openCanvas, pickPort, shot, verdict, waitForPort } from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

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
const DATA = ".verify/size-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12490]);
const child = spawn(
  "node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: ".", env, stdio: ["ignore", "ignore", "ignore"] },
);
/* 固定等 8 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await openCanvas(page);
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
await shot(page, ".verify/shots-final/gen-size.png");

console.log(JSON.stringify(report, null, 2));

const flat = Object.entries(report.ratioTable).flatMap(([r, arr]) => arr.map((x) => ({ r, ...x })));
console.log("\n比例表核对：", flat.every((x) => x.ok) ? `全部 ${flat.length} 条对上` : "有对不上的");
for (const x of flat.filter((v) => !v.ok)) console.log("  ✗", x.r, x.tier, "得到", x.got, "应为", x.want);

await browser.close();
child.kill();

/*
 * ── 判定（2026-10-16，审计 A20 收进批跑时补）──────────────────────────
 *
 * ⚠️ 这条原来**没有退出码判定**（靠 `failOnMarks` 兜"谁印了 ✗"，而"真按选定尺寸出图"
 * 那一步只打了报告）—— 在批跑里它是最危险的那类：报告漂亮、其实没断。
 * 前 5 段是纯计算（读界面算出来的尺寸对不对规格表），第 6 段才是**真的出图**。
 */
const bad = [];
const need = (ok, why) => {
  if (!ok) bad.push(why);
};

need(
  JSON.stringify(report.modes) === JSON.stringify(["gen-size-mode-auto", "gen-size-mode-ratio", "gen-size-mode-resolution"]),
  `三档模式不对：${JSON.stringify(report.modes)}`,
);
for (const x of flat) {
  need(x.ok, `比例表对不上：${x.r} ${x.tier} 得到 ${x.got}，应为 ${x.want}`);
}
need(/由模型决定|auto/.test(report.autoText ?? ""), `自动模式没有说清"由模型决定"：${report.autoText}`);

/* 自定义宽高：1920×1080 不是合法尺寸（高不是 16 的倍数）→ 必须带「已规整」提示 */
need(/已规整/.test(report.customText ?? ""), `1920×1080 没有被规整提示：${report.customText}`);

/* 极端比例（3840×400）：要么明确说无效，要么给出规整后的合法尺寸 —— 不许原样受理 */
{
  const shown = /将使用\s*(\d+x\d+)/.exec(report.longText ?? "")?.[1];
  const hasDefiniteWord = /尺寸无效|已规整/.test(report.longText ?? "");
  need(hasDefiniteWord, `3840×400 既没说无效也没说已规整：${report.longText}`);
  need(shown !== "3840x400", `3840×400 被原样受理了（比例超 3:1）：${report.longText}`);
  if (shown) {
    const [w, h] = shown.split("x").map(Number);
    need(
      w % 16 === 0 && h % 16 === 0 && w <= 3840 && h <= 3840 && Math.max(w / h, h / w) <= 3,
      `规整后的尺寸仍不合规：${shown}`,
    );
  }
}

/* ⭐ 第 6 段：真出的那张图**就是选定的 1280×720**（16:9 / 1K），不是模型随手给的 */
need(/将使用\s*1280x720/.test(report.beforeRun ?? ""), `生成前显示的尺寸不是 1280x720：${report.beforeRun}`);
need(
  report.generatedSize?.w === 1280 && report.generatedSize?.h === 720,
  `出的图尺寸与选定规格不符：${JSON.stringify(report.generatedSize)}（应为 1280×720）`,
);

await verdict(bad, "图像尺寸规格（三档模式齐 / 比例表逐格对上 / 自动与规整的提示 / 极端比例不被原样受理 / 真按 16:9 1K 出 1280×720）");

