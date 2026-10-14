import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, shot } from "./harness.mjs";

/**
 * 图片生成端到端验收（阶段 9.2 / 9.3 的图）。
 *
 * 断言：
 *   1. 底部工具条存在，且带原版契约 `data-canvas-bottom-toolbar`
 *   2. 图片生成面板能开、有提示词/模型/尺寸/生成
 *   3. **真的生成出一张图**，并落成画布上的图片节点
 *   4. 图片**真的能显示**（naturalWidth > 0）—— 这一条验的是 `dshasset://` 自定义协议；
 *      协议没接上的话 src 会 404，节点会是个破图
 *   5. 视频生成面板如实说"没有通道"，不是个点了没反应的按钮
 *   6. 生成结果落盘，且文档里**只有文件名**（不是几百 KB 的 base64）
 *   7. 重启后图还在
 */
const DATA = ".verify/gen-data";
const SNAP = path.join(DATA, "canvas", "document.json");
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const EXE = "node_modules/electron/dist/electron.exe";
async function boot(port) {
  const child = spawn(EXE, [".", `--remote-debugging-port=${port}`], {
    cwd: ".",
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise((r) => setTimeout(r, 8000));
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${port}`);
  const pages = browser.contexts()[0].pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
  await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);
  
  await page.waitForSelector(".react-flow__node", { state: "attached" });
  await page.waitForTimeout(2500);
  return { child, browser, page };
}

const report = {};
{
  const { child, browser, page } = await boot(9470);

  // 1) 底部工具条契约
  report.bottomContract = await page.$eval('[data-canvas-bottom-toolbar]', (el) => ({
    testid: el.getAttribute("data-testid"),
    buttons: Array.from(el.querySelectorAll("button")).map((b) => b.getAttribute("data-testid") ?? b.textContent?.trim()),
  }));

  // 2) 视频生成如实说没通道
  await page.locator('[data-testid="bottom-video-gen"]').click();
  await page.waitForTimeout(500);
  report.videoPanelText = await page.locator('[data-testid="video-unavailable"]').textContent();
  await page.locator('[data-testid="bottom-video-gen"]').click();
  await page.waitForTimeout(400);

  // 3) 图片生成
  await page.locator('[data-testid="bottom-image-gen"]').click();
  await page.waitForTimeout(700);
  report.imagePanelOpen = await page.locator('[data-testid="gen-panel-image"]').count();
  report.modelOptions = await page.$$eval('[data-testid="gen-model"] option', (els) =>
    els.map((e) => e.textContent?.trim()),
  );
  report.sizeOptions = await page.$$eval('[data-testid="gen-size"] option', (els) =>
    els.map((e) => e.textContent?.trim()),
  );

  const nodesBefore = await page.locator(".react-flow__node").count();
  const imagesBefore = await page.locator(".react-flow__node-image img").count();
  await page.locator('[data-testid="gen-prompt"]').fill("一只柯基犬在向日葵田里奔跑，阳光明媚，摄影风格");
  await page.waitForTimeout(300);
  await page.locator('[data-testid="gen-run"]').click();

  /**
   * 等出图（实测约 35 秒）。
   *
   * ⚠️ 判据不能是"图片节点数 > 0" —— **示例画布里本来就有一个图片节点**，
   * 那个条件一上来就成立，会立刻返回、然后在生成完成前就采样（第一次写这个脚本
   * 就是这么被骗过去的：报了个 nodeCreated: 0，其实功能是好的）。
   * 所以等的是"新出现了一张带 `dshasset://` 的图"，那才是生成出来的。
   */
  await page
    .waitForFunction(
      () => document.querySelector('.react-flow__node-image img[src^="dshasset://"]') !== null,
      null,
      { timeout: 180000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(2000);

  const nodesAfter = await page.locator(".react-flow__node").count();
  report.imagesBefore = imagesBefore;
  report.nodeCreated = nodesAfter - nodesBefore;
  report.imageSrc = await page
    .locator('.react-flow__node-image img[src^="dshasset://"]')
    .first()
    .getAttribute("src")
    .catch(() => null);
  report.imageLoaded = await page.evaluate(() => {
    const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
    return img instanceof HTMLImageElement ? img.complete && img.naturalWidth > 0 : "没有生成图";
  });
  report.imageNaturalSize = await page.evaluate(() => {
    const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
    return img instanceof HTMLImageElement ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  });
  report.genToast = await page.locator(".canvas-toast").textContent().catch(() => null);

  await shot(page, ".verify/shots-final/gen-image.png");

  // 6) 落盘 + 文档里只有文件名
  await page.waitForTimeout(2000);
  if (fs.existsSync(SNAP)) {
    const doc = JSON.parse(fs.readFileSync(SNAP, "utf8"));
    const img = doc.nodes.find((n) => n.type === "image" && n.data?.src);
    report.docSrc = img?.data?.src ?? null;
    report.docSrcLen = (img?.data?.src ?? "").length;
    report.docFilePath = img?.data?.filePath ?? null;
  }
  const assetDir = path.join(DATA, "assets");
  report.assetsOnDisk = fs.existsSync(assetDir)
    ? fs.readdirSync(assetDir).map((f) => ({ f, bytes: fs.statSync(path.join(assetDir, f)).size }))
    : [];

  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2000));
}

// 7) 重启后图还在
{
  const { child, browser, page } = await boot(9471);
  report.afterRestart = await page.evaluate(() => {
    const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
    if (!(img instanceof HTMLImageElement)) return { found: false };
    return { found: true, src: img.getAttribute("src"), w: img.naturalWidth, h: img.naturalHeight };
  });
  await browser.close();
  child.kill();
}

console.log(JSON.stringify(report, null, 2));
