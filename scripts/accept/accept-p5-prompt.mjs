import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 验证「标记当提示词」真的把标记拼进了发给模型的要求（阶段 5.3）。
 *
 * 断言的是 `generateContent` 组装出来的**实际请求文本**（dev 期挂在
 * `window.__lastAiPrompt`）。preload 的 `shell` 在渲染进程是冻结的，
 * 没法从页面里包一层抓 IPC，所以用这个观察点。
 */

const DATA = "D:/DoubaoWorkClone/data";
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=9310"],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9310");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
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
