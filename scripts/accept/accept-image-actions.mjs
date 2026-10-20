import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, failOnMarks, openCanvas, pickPort, shot, verdict, waitForPort, dismissFirstRunIfShown } from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

/**
 * 图片动作端到端验收（阶段 9.3）。
 *
 * ⭐ 2026-10-16（审计 A20）：**已收进免模型批跑**。它原来卡在"必须真调图像模型"——
 * 因为图像通道那张表没有 baseURL 覆盖口，批跑的假通道指不进去。这次两半都补上了
 * （产品侧 `IMAGE_PROVIDERS` 加 `baseURLEnv`、装置侧假通道认 `/images/generations`
 * 与 `/images/edits` 并按请求的 `size` 现造真 PNG），于是它能在零出网下跑。
 * 同时补上**真判定** —— 这份脚本原来一条判定都没有（只有报告）。
 *
 * 断言：
 *   1. 先生成一张图（有图才能改）
 *   2. 图片节点上出现「改图」入口，菜单里四项：抠图 / 变清晰 / 扩图 / 编辑（+ 自由编辑的「改」）
 *   3. **真跑一次「变清晰」**：拿到新图、节点 src 换成新文件、尺寸沿用原图
 *   4. **真跑一次「扩图」**：输出尺寸比输入大（扩图按定义要更大的画布）
 *   5. 图片真的能显示（naturalWidth > 0）
 *   6. **Ctrl+Z 能撤回**改图（改之前记了历史）
 *   7. 自由编辑的空指令时「改」按钮置灰
 *   8. 点了动作**立刻有反馈**（忙碌提示真的出现过）
 */
const DATA = ".verify/actions-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const EXE = "node_modules/electron/dist/electron.exe";
/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12495]);
const child = spawn(EXE, [".", "--remote-debugging-port=" + __port], {
  cwd: ".",
  env,
  stdio: ["ignore", "ignore", "ignore"],
});
/* 固定等 8 秒会在机器忙时不够（应用还没监听）→ 改成轮询端口：实测过的失败形态是 `ECONNREFUSED`（= 什么都没在听，不是端口坏）。 */
await waitForPort(__port, 40000);

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await dismissFirstRunIfShown(page);
await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached" });
await page.waitForTimeout(2500);

const report = {};
const genImg = () =>
  page.evaluate(() => {
    const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
    return img instanceof HTMLImageElement
      ? { src: img.getAttribute("src"), w: img.naturalWidth, h: img.naturalHeight }
      : null;
  });

// 1) 先真生成一张图（当改图的输入）
await page.locator('[data-testid="bottom-image-gen"]').click();
await page.waitForTimeout(700);
await page.locator('[data-testid="gen-prompt"]').fill("一只白猫坐在木桌上，旁边有一盆绿植，室内自然光");
await page.locator('[data-testid="gen-run"]').click();
await page
  .waitForFunction(() => document.querySelector('.react-flow__node-image img[src^="dshasset://"]') !== null, null, {
    timeout: 180000,
  })
  .catch(() => undefined);
await page.waitForTimeout(2500);
report.source = await genImg();

// 找到**带生成图的那个**图片节点 id。
// 注意不能用 `.react-flow__node-image` 的第一个 —— 示例画布里本来就有一个空的图片节点（n5），
// 它没有 src 也就没有「改图」入口，抓错了会一直等不到按钮。
const nodeId = await page.evaluate(() => {
  const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
  return img?.closest(".react-flow__node")?.getAttribute("data-id") ?? null;
});
report.nodeId = nodeId;

// 2) 打开改图菜单
await page.locator(`[data-testid="image-actions-${nodeId}"]`).click();
await page.waitForTimeout(500);
report.menuActions = await page.$$eval('[data-image-action]', (els) =>
  els.map((e) => e.getAttribute("data-image-action")),
);
report.emptyInstructionDisabled = await page
  .locator(`[data-testid="image-action-edit-go-${nodeId}"]`)
  .isDisabled();

// 3) 增强（产品里的标签是「变清晰」）：沿用原尺寸
/*
 * ⚠️ 「点下去有没有反馈」要**盯着 DOM 数**，不能点完等 1.5 秒再采样（2026-10-16）：
 * 假通道几百毫秒就把图给回来了，等完那 1.5 秒忙碌提示早就撤了 ——
 * 那会把"有反馈"误判成"点了没反应"（这台装置自己造出来的假红）。
 * 所以点之前挂一个 MutationObserver，数它**出现过**几次。
 */
await page.evaluate((id) => {
  const seen = { value: 0 };
  window.__dshBusySeen = seen;
  const observer = new MutationObserver(() => {
    if (document.querySelector(`[data-testid="image-action-busy-${id}"]`)) seen.value += 1;
  });
  observer.observe(document.body, { childList: true, subtree: true });
}, nodeId);
await page.locator(`[data-testid="image-action-enhance-${nodeId}"]`).click();
await page.waitForTimeout(400);
report.busyShown = await page.evaluate(() => window.__dshBusySeen?.value ?? 0);
await page
  .waitForFunction(
    (src) => {
      const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
      return img !== null && img.getAttribute("src") !== src;
    },
    report.source?.src,
    { timeout: 240000 },
  )
  .catch(() => undefined);
await page.waitForTimeout(2000);
report.afterEnhance = await genImg();
report.errorAfterEnhance = await page.locator(`[data-testid="image-error-${nodeId}"]`).textContent().catch(() => null);

// 4) 扩图：尺寸应变大
await page.locator(`[data-testid="image-actions-${nodeId}"]`).click();
await page.waitForTimeout(400);
await page.locator(`[data-testid="image-action-expand-${nodeId}"]`).click();
await page.waitForTimeout(1500);
await page
  .waitForFunction(
    (src) => {
      const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
      return img !== null && img.getAttribute("src") !== src;
    },
    report.afterEnhance?.src,
    { timeout: 240000 },
  )
  .catch(() => undefined);
await page.waitForTimeout(2000);
report.afterExpand = await genImg();
report.errorAfterExpand = await page.locator(`[data-testid="image-error-${nodeId}"]`).textContent().catch(() => null);
await shot(page, ".verify/shots-final/image-actions.png");

// 6) Ctrl+Z 撤回
await page.locator("body").click({ position: { x: 800, y: 500 } }).catch(() => undefined);
await page.waitForTimeout(300);
await page.keyboard.press("Control+z");
await page.waitForTimeout(1500);
report.afterUndo = await genImg();

report.assets = fs.existsSync(path.join(DATA, "assets"))
  ? fs.readdirSync(path.join(DATA, "assets")).map((f) => ({ f, bytes: fs.statSync(path.join(DATA, "assets", f)).size }))
  : [];

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();

/*
 * ── 判定（2026-10-16，审计 A20 收进批跑时补）──────────────────────────
 *
 * ⚠️ 这条原来**只有报告、一条判定都没有**（`failOnMarks()` 兜的是"谁印了 ✗"，
 * 而它一处 ✗ 都不印）—— 在批跑里等于没测。判据就是脚本头部承诺的那几条：
 * 有图可改 / 菜单四项齐 / **真改出一版新图**（新文件名，不是把原来那张改名）/
 * 变清晰沿用原尺寸而扩图**必须更大** / 图能显示 / 图落盘 / Ctrl+Z 能撤回。
 */
const bad = [];
const need = (ok, why) => {
  if (!ok) bad.push(why);
};
need(
  typeof report.source?.src === "string" && report.source.src.startsWith("dshasset://"),
  `第一步没生成出可改的图：${JSON.stringify(report.source)}`,
);
need((report.source?.w ?? 0) > 0, "生成出来的图 naturalWidth 为 0（破图）");

const actions = report.menuActions ?? [];
for (const id of ["cutout", "enhance", "expand", "edit"]) {
  need(actions.includes(id), `改图菜单里缺 ${id}（实际 ${JSON.stringify(actions)}）`);
}
need(report.emptyInstructionDisabled === true, "自由编辑的空指令时，「改」按钮没有置灰");
need((report.busyShown ?? 0) >= 1, "改图期间没有「正在改图」的提示");

/* 变清晰：**换了一张新图**（src 变了），且沿用原尺寸（scale 策略 keep） */
need(
  typeof report.afterEnhance?.src === "string" && report.afterEnhance.src !== report.source?.src,
  `点了「变清晰」没有换出新图：${JSON.stringify(report.afterEnhance)}`,
);
need((report.afterEnhance?.w ?? 0) > 0, "变清晰之后图不显示了（dshasset 协议或落盘断了）");
need(
  report.afterEnhance?.w === report.source?.w && report.afterEnhance?.h === report.source?.h,
  `变清晰没有沿用原尺寸：原 ${report.source?.w}×${report.source?.h} → 新 ${report.afterEnhance?.w}×${report.afterEnhance?.h}`,
);
need(!report.errorAfterEnhance, `变清晰报了错：${report.errorAfterEnhance}`);

/* 扩图：按定义**输出更大**（factor 2） */
need(
  typeof report.afterExpand?.src === "string" && report.afterExpand.src !== report.afterEnhance?.src,
  `点了「扩图」没有换出新图：${JSON.stringify(report.afterExpand)}`,
);
need(
  (report.afterExpand?.w ?? 0) > (report.afterEnhance?.w ?? 0) &&
    (report.afterExpand?.h ?? 0) > (report.afterEnhance?.h ?? 0),
  `扩图之后尺寸没变大：${report.afterEnhance?.w}×${report.afterEnhance?.h} → ${report.afterExpand?.w}×${report.afterExpand?.h}`,
);
need(!report.errorAfterExpand, `扩图报了错：${report.errorAfterExpand}`);

/* 三张图（原图 + 变清晰 + 扩图）都在磁盘上，且不是几十字节的占位 */
need((report.assets ?? []).length >= 3, `磁盘上的生成图不足 3 张：${JSON.stringify((report.assets ?? []).map((a) => a.f))}`);
need(
  (report.assets ?? []).filter((a) => a.bytes > 1000).length >= 3,
  `磁盘上有图但太小（可能只存了空壳）：${JSON.stringify(report.assets)}`,
);

/* Ctrl+Z 撤回：回到"变清晰"那一版 */
need(
  report.afterUndo?.src === report.afterEnhance?.src,
  `Ctrl+Z 没有撤回改图：撤回后 ${report.afterUndo?.src}，应为 ${report.afterEnhance?.src}`,
);

await verdict(bad, "图片动作条（有图可改 / 菜单四项 / 变清晰换新图且沿用尺寸 / 扩图更大 / 图能显示且落盘 / Ctrl+Z 撤回）");

