import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openSummary, pickPort, shot, waitForPort, dismissFirstRunIfShown } from "./harness.mjs";

/**
 * 11.13 验收：右栏「图片与视频」画廊 + 另两个 tab 的如实空态。
 *
 * 画廊的关键是**缩略图真的取到了**：图片在产物/导出/云盘三个目录里，
 * 而 `dshasset://` 原来只服务 assets 目录。所以断言里要看 `naturalWidth > 0`
 * —— 只看有没有 `<img>` 标签是过不了这一关的（破图也有标签）。
 */
const DATA = ".verify/media-data";
fs.rmSync(DATA, { recursive: true, force: true });

// 预置几张真图片（1×1 PNG 的最小合法字节）与一个假视频
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
fs.mkdirSync(path.join(DATA, "drive"), { recursive: true });
fs.mkdirSync(path.join(DATA, "exports"), { recursive: true });
fs.mkdirSync(path.join(DATA, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(DATA, "drive", "封面图.png"), PNG);
fs.writeFileSync(path.join(DATA, "exports", "画布-2026.png"), PNG);
fs.writeFileSync(path.join(DATA, "artifacts", "生成的图.png"), PNG);
fs.writeFileSync(path.join(DATA, "drive", "说明.md"), "# 不是图片\n");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12590]);
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
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await dismissFirstRunIfShown(page);
await page.waitForTimeout(1500);

const report = {};

/* 右栏 2026-10-14 起默认收起（照 Ding Harness 原型：塌成右缘一条竖直把手）→ 先展开再点页签 */
report.summaryOpened = await openSummary(page);

/* ---------- 图片与视频 ---------- */
await page.locator('[data-testid="wb-summary-tab-media"]').click();
await page.waitForTimeout(2500);

report.mediaCells = await page.locator(".wb-media-cell").count();
report.imageNames = await page.$$eval(".wb-media-name", (els) => els.map((e) => e.textContent));
report.note = await page.locator('[data-testid="wb-media-note"]').textContent().catch(() => null);

// **关键：缩略图真的加载出来了**（而不是破图）
report.thumbLoad = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll(".wb-media-thumb"));
  return imgs.map((img) => ({
    src: img.getAttribute("src") ?? "",
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    ok: img.naturalWidth > 0,
  }));
});
report.allThumbsOk = report.thumbLoad.every((t) => t.ok);

await shot(page, ".verify/shots-final/wb-18-media.png");

/* ---------- 另两个 tab 的如实空态 ---------- */
await page.locator('[data-testid="wb-summary-tab-browser"]').click();
await page.waitForTimeout(600);
report.browserEmpty = await page.locator('[data-testid="wb-summary-empty-browser"]').textContent().catch(() => null);

await page.locator('[data-testid="wb-summary-tab-subtasks"]').click();
await page.waitForTimeout(600);
report.subtasksEmpty = await page.locator('[data-testid="wb-summary-empty-subtasks"]').textContent().catch(() => null);
/*
 * ⚠️ 不实陈述守卫（2026-10-13 加）。
 *
 * 这一句以前写着「本次实现不含子智能体调度」—— 而子智能体**早就落地了**
 * （§150 端到端验过、§176 补了"上交父级就地批准"）。文案与代码相反时，
 * 用户会以为这个能力不存在。改成如实说法之后，这里钉一条：**那半句不许回来**。
 */
report.subtasksCopyHonest = !(report.subtasksEmpty ?? "").includes("不含子智能体调度");
if (!report.subtasksCopyHonest) {
  console.error("✗ 子智能体 tab 又写成「不含子智能体调度」—— 那是与代码相反的文案");
  process.exitCode = 1;
}

/* ---------- 视频接口：真接上了，只是没模型 ---------- */
report.video = await page.evaluate(async () => {
  const shell = window.shell;
  if (!shell?.video) return { error: "没有 video 通道" };
  const models = await shell.video.listModels();
  const attempt = await shell.video.generate("一只猫在草地上跑");
  return { models, attempt };
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();
