import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, shot } from "./harness.mjs";

/**
 * 打包产物端到端验收（阶段 9.4 / 9.5）。
 *
 * 光"生成了 setup.exe"不算数 —— 要证明**装出来的那个东西真的能跑**：
 *   1. 解包目录里的 exe 起得来，加载的是 asar 里的 renderer
 *   2. 主进程入口在 asar 内、且崩溃兜底壳在
 *   3. 底部工具条 / 图片生成 / 图层面板 / 文字排版 这些新功能在打包版里也在
 *   4. **打包版能真的生成图片**（自定义协议 + assets 目录在系统 userData 下也成立）
 *   5. 开发态才有的探针（`__canvasStore`）在打包版里**不存在**
 */
const UNPACKED = "D:/DoubaoWorkClone/release/win-unpacked";
const EXE = path.join(UNPACKED, "工作台.exe");
if (!fs.existsSync(EXE)) {
  console.log("没有解包产物，先 pnpm build");
  process.exit(1);
}

const report = {};

// 1) asar 里有没有主进程入口（打包后代码在 asar 内，不在磁盘目录里）
const asar = path.join(UNPACKED, "resources", "app.asar");
const asarBytes = fs.readFileSync(asar);
report.asarHasMain = asarBytes.includes(Buffer.from("dist-electron/electron/main.impl.cjs"));
report.asarHasEntryShell = asarBytes.includes(Buffer.from("ENTRY-LOAD-FAILED"));
report.asarHuman = `${(asarBytes.length / 1024 / 1024).toFixed(1)} MB`;

// 2) 起打包后的应用
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_DEBUG_PORT = "9480";
// 打包版写系统 userData；给它一个独立目录，别污染真实配置
const PORTABLE_DATA = "D:/DoubaoWorkClone/.verify/packaged-userdata";
fs.rmSync(PORTABLE_DATA, { recursive: true, force: true });
env.DSH_CANVAS_DATA_DIR = PORTABLE_DATA;

const child = spawn(EXE, [], { env, stdio: ["ignore", "pipe", "pipe"] });
let bootLog = "";
child.stdout?.on("data", (d) => (bootLog += d.toString()));
child.stderr?.on("data", (d) => (bootLog += d.toString()));

await new Promise((r) => setTimeout(r, 12000));

let browser;
try {
  browser = await connectWithRetry(chromium, "http://127.0.0.1:9480");
} catch (error) {
  console.log("连不上调试口：", String(error).slice(0, 200));
  console.log("启动日志：", bootLog.slice(-800));
  child.kill();
  process.exit(1);
}

const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
report.pageUrl = page.url().replace(/\\/g, "/").slice(-60);
/*
   * 应用现在**默认打开工作台**，画布要点「打开画布」才出来。
   * 这条脚本写的时候应用是**画布优先**形态（开头直接等 .react-flow__node），
   * 于是它在这一步 30 秒超时退出 —— 而它已很多轮没人跑过，
   * 直到 §96 的批跑器第一次跑起来才被撞见（§97）。
   */
  await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
  await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);
  await page.waitForSelector(".react-flow__node", { state: "attached", timeout: 30000 });
await page.waitForTimeout(2500);

// 3) 新功能在不在
report.features = await page.evaluate(() => ({
  bottomToolbar: document.querySelectorAll("[data-canvas-bottom-toolbar]").length,
  imageGenButton: document.querySelectorAll('[data-testid="bottom-image-gen"]').length,
  videoGenButton: document.querySelectorAll('[data-testid="bottom-video-gen"]').length,
  layerButton: document.querySelectorAll('[data-testid="open-layers"]').length,
  exportButton: document.querySelectorAll('[data-testid="export-menu"]').length,
  nodes: document.querySelectorAll(".react-flow__node").length,
}));

// 4) 开发态探针不该存在
report.devProbes = await page.evaluate(() => ({
  canvasStore: typeof window.__canvasStore,
  lastAiPrompt: typeof window.__lastAiPrompt,
  lastChatPayload: typeof window.__lastChatPayload,
}));

// 5) 打包版真的生成一张图
report.imageModels = await page.evaluate(async () => {
  try {
    return await window.shell.image.listModels();
  } catch (e) {
    return { error: String(e) };
  }
});

await page.locator('[data-testid="bottom-image-gen"]').click();
await page.waitForTimeout(700);
await page.locator('[data-testid="gen-prompt"]').fill("一只白色的兔子在雪地里，冬日阳光");
await page.waitForTimeout(300);

const nodesBefore = await page.locator(".react-flow__node").count();
await page.locator('[data-testid="gen-run"]').click();
await page
  .waitForFunction(() => document.querySelector('.react-flow__node-image img[src^="dshasset://"]') !== null, null, {
    timeout: 180000,
  })
  .catch(() => undefined);
await page.waitForTimeout(2500);

report.generated = await page.evaluate(() => {
  const img = document.querySelector('.react-flow__node-image img[src^="dshasset://"]');
  return img instanceof HTMLImageElement
    ? { src: img.getAttribute("src"), w: img.naturalWidth, h: img.naturalHeight }
    : null;
});
report.nodesDelta = (await page.locator(".react-flow__node").count()) - nodesBefore;

await shot(page, "D:/DoubaoWorkClone/.verify/shots-final/packaged.png");

// 6) 打包版的导出目录 / assets 落在哪里
report.assetsDir = fs.existsSync(path.join(PORTABLE_DATA, "assets"))
  ? fs.readdirSync(path.join(PORTABLE_DATA, "assets"))
  : "(无)";

console.log(JSON.stringify(report, null, 2));
await browser.close();
child.kill();
