import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, connectWithRetry, killTree, openCanvas, pickPort, shot, verdict } from "./harness.mjs";

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

/*
 * ⚠️ 2026-10-16：这里原来自己裸 `spawn` + 固定睡 8 秒 + `connectWithRetry` ——
 * 本机有"TCP 通但 Electron 调试服务器不答"的端口区间，裸写法会卡到 30 秒超时
 * （实测：`waiting for locator('[data-testid="wb-canvas-toggle"]')`，
 * 而同一台机器上走批跑的画布脚本是绿的 —— 所以那不是产品坏了，是起法不对）。
 * 改走 `harness` 的 `bootApp`：换端口重试 + 按标签认领子进程（那三层端口坑的记录在 harness 里）。
 */
async function boot() {
  const booted = await bootApp({ port: await pickPort([9470]), dataDir: DATA, timeoutMs: 40_000 });
  if (!booted.ok) {
    console.error("[诊断] 应用输出尾部：" + (booted.getLog() || "(空)").slice(-1200));
    await killTree(booted.child);
    process.exit(1);
  }
  const browser = await connectWithRetry(chromium, `http://127.0.0.1:${booted.port}`);
  const pages = browser.contexts()[0].pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
  await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);

  await page.waitForSelector(".react-flow__node", { state: "attached" });
  await page.waitForTimeout(2500);
  return { child: booted.child, browser, page };
}

const report = {};
{
  const { child, browser, page } = await boot();

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
  const { child, browser, page } = await boot();
  report.afterRestart = await page.evaluate(() => {
    const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
    if (!(img instanceof HTMLImageElement)) return { found: false };
    return { found: true, src: img.getAttribute("src"), w: img.naturalWidth, h: img.naturalHeight };
  });
  await browser.close();
  child.kill();
}

console.log(JSON.stringify(report, null, 2));

/*
 * ── 判定（2026-10-16 补）──────────────────────────────────────────
 *
 * ⚠️ 这个脚本原来**只打报告、一处判定都没有** —— 跑通等于没测（本仓反复治的那类），
 * 而它恰好是**图片链唯一的端到端证据**（真调图像模型出图）。
 * 所以把要断言的事逐条列出来，任一条不成立就退非零；顺带把 P11/P21 那两处
 * （文件名唯一化 / 不含 ISO 的大写 `T`）钉在这里 —— 它们只有真跑一次才看得见。
 */
const bad = [];
const need = (ok, why) => {
  if (!ok) bad.push(why);
};
need(Boolean(report.bottomContract), "底部工具条不见了");
need(report.imagePanelOpen >= 1, "图片生成面板没打开");
need(report.nodeCreated === 1, "没有真的落成图片节点（模型没出图，或结果没落回去）");
need(report.imageLoaded === true, "图片没显示 —— `dshasset://` 自定义协议可能没接上");
need((report.imageNaturalSize?.w ?? 0) > 0, "图片 naturalWidth 为 0（破图）");
need((report.assetsOnDisk ?? []).some((a) => a.bytes > 1000), "磁盘上没有落盘图片");
need(
  typeof report.docSrc === "string" && report.docSrc.startsWith("dshasset://"),
  "文档里图片 src 不是 dshasset://",
);
need(
  (report.docSrcLen ?? 0) > 0 && (report.docSrcLen ?? 0) < 300,
  `文档里存进 base64 了（应该只存文件名）：srcLen=${report.docSrcLen}`,
);
const assetName = report.assetsOnDisk?.[0]?.f ?? "";
need(assetName !== "", "拿不到落盘文件名");
/* P11/P21 的回归判据：文件名唯一化用的是毫秒时间戳，**不许出现大写字母**（旧实现带 ISO 的 `T`） */
need(!/[A-Z]/.test(assetName), `落盘文件名里出现大写字母（旧实现带 ISO 的 T）：${assetName}`);
need(report.afterRestart?.found === true, "重启后图没了");

await verdict(bad, "图片生成端到端（真出一张图 / 能显示 / 文档只存文件名 / 重启还在）");
