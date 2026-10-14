import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, openCanvas, pickPort, waitForPort } from "./harness.mjs";

/* ══════════════════════════════════════════════════════════════════════
 * ⚠️ **退役（2026-10-14）—— 保留供开发期手工排查，不再维护、不在任何清单里。**
 *
 * 它验的是「标记当提示词」有没有把标记拼进发给模型的要求（阶段 5.3），
 * 做法是从 `window.__lastAiPrompt` 读**实际请求文本** —— 而那个探针是
 * `import.meta.env.DEV` 才挂的（`canvasGenerate.ts:143`），**打包产物里没有**。
 * 而验收跑的、以及本文件下面 spawn 的都是**打包产物** → 这条脚本
 * **在任何时候都跑不到那个观察点**（它在历史记录里长期是红的，就是这么来的）。
 *
 * ## 它要守的东西现在归谁
 * `instructionFromMarkers` 已从 `CanvasRuntime.tsx` 搬进纯模块 `markers.ts`
 * （依赖方向也正过来了：不再认识 store 与节点类型表），由
 * **`src/canvas/markers.test.ts` 里那 5 条单测**守着：
 *   · 开关打开 + 圈住节点 → 要求里出现「【画布标记】」与节点名
 *   · 开关关着 → 原样返回（不许偷偷改用户的要求）
 *   · 没有标记 → 原样返回（不拼一个空段）
 *   · 圈在空白处 → 照样进去，但不硬说命中谁
 *   · 批注文字逐字进要求
 * 比原来那条"跑起来、点生成、等模型"的链路更快也更稳，而且**不需要模型**。
 *
 * ## 还留着它干嘛
 * 开发构建（`npm run dev:web`，DEV 为真）里那个探针是有的，
 * 想连真模型手工看一次实际请求文本时，这条还能用。
 * ══════════════════════════════════════════════════════════════════════ */

/* 数据目录隔离（2026-10-14）：原来指到真实 `data/`，跑一次就在真实画布上画标记。 */
const DATA = ".verify/p5prompt-data";
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12310]);
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

// 1) 在节点上画一个圈 + 一条批注
await page.locator('[data-marker-tool="rect"]').click();
await page.waitForTimeout(150);
const first = await page.locator(".react-flow__node").first().boundingBox();
await page.mouse.move(first.x - 12, first.y - 12);
await page.mouse.down();
await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 6 });
await page.mouse.move(first.x + first.width + 12, first.y + first.height + 12, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(300);

await page.locator('[data-marker-tool="text"]').click();
await page.waitForTimeout(150);
await page.mouse.click(first.x + first.width + 40, first.y + 10);
await page.locator('[data-testid="marker-text-input"] textarea').fill("这块内容要压缩成三行");
await page.locator('[data-testid="marker-text-input"] textarea').press("Enter");
await page.waitForTimeout(300);

// 2) 选中该节点（Ctrl 点击）后生成
/*
 * `.canvas-mode` 按钮在**弹出层**里（BottomToolbar 第 80 行的 `bottom-menu-pop`，
 * testid `bottom-modes`）—— 要先点 `bottom-select` 把它展开，模式按钮才出现。
 *（§112：之前直接点模式按钮必然超时，因为那时它还不存在。）
 */
await page.locator('[data-testid="bottom-select"]').click();
await page.waitForTimeout(700);
await page.waitForSelector('[data-testid="bottom-modes"]', { timeout: 8000 });
await page.locator('.canvas-mode[data-mode="point"]').click();
await page.waitForTimeout(150);
await page.mouse.click(first.x + first.width / 2, first.y + 8);
await page.waitForTimeout(300);

const runGenerate = async () => {
  await page.locator('[data-testid="ai-generate"]').click();
  await page.waitForTimeout(250);
  const item = page.locator('[data-testid="ai-generate"] [data-intent="write"], .canvas-menu [data-intent="write"]');
  await item.first().click();
  await page.waitForTimeout(12000);
  return page.evaluate(() => window.__lastAiPrompt ?? null);
};

const on = await runGenerate();

console.log(
  JSON.stringify(
    {
      hasSystem: Boolean(on?.system),
      userHead: (on?.user ?? "").slice(0, 160),
      userTail: (on?.user ?? "").slice(-260),
      containsMarkerBlock: (on?.user ?? "").includes("【画布标记】"),
      containsMarkerText: (on?.user ?? "").includes("这块内容要压缩成三行"),
      containsNodeRef: /节点(\d)/.test(on?.user ?? ""),
    },
    null,
    2,
  ),
);

// 3) 关掉开关再生成一次，应不再带标记段
await page.locator('[data-testid="marker-prompt"]').click();
await page.waitForTimeout(250);
const off = await runGenerate();

console.log(
  JSON.stringify(
    {
      offContainsMarkerBlock: (off?.user ?? "").includes("【画布标记】"),
      offContainsMarkerText: (off?.user ?? "").includes("这块内容要压缩成三行"),
      offUserHead: (off?.user ?? "").slice(0, 120),
    },
    null,
    2,
  ),
);

await browser.close();
child.kill();
