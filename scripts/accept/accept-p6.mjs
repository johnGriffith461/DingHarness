import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * 打包产物验收（阶段 6）：直接跑 `release/win-unpacked/工作台.exe`，
 * 确认它**不依赖 dev server、不依赖工程目录**也能起来，
 * 并且画布、AI 通道、持久化都还在。
 *
 * 两个必须处理的坑：
 *   ① 本机环境里带着 `ELECTRON_RUN_AS_NODE=1`（HANDOFF §6.0），不清掉的话
 *      Electron 会把自己当 Node 跑 —— 没有脚本、直接退出码 0，看起来像"应用秒退"。
 *   ② 数据目录用 DSH_CANVAS_DATA_DIR 指到临时位置，别污染真实 userData。
 */
const DATA = "D:/DoubaoWorkClone/.verify/packaged-data";
fs.rmSync(DATA, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;
// 打包产物不认命令行上的 --remote-debugging-port，用主进程里的显式开关
env.DSH_DEBUG_PORT = "9330";

const exe = "D:/DoubaoWorkClone/release/win-unpacked/工作台.exe";
if (!fs.existsSync(exe)) {
  console.log("打包产物不存在：", exe);
  process.exit(1);
}

const child = spawn(exe, [], {
  cwd: "D:/DoubaoWorkClone/release/win-unpacked",
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let err = "";
child.stderr.on("data", (d) => (err += String(d)));
await new Promise((r) => setTimeout(r, 10000));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9330");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);

await page.waitForSelector(".react-flow__node", { state: "attached", timeout: 30000 });
await page.waitForTimeout(2500);

const report = {};
report.url = page.url();
report.title = await page.title();
report.nodes = await page.locator(".react-flow__node").count();
report.edges = await page.locator(".react-flow__edge").count();
report.toolbar = await page.locator(".canvas-toolbar").count();
report.markerToolbar = await page.locator('[data-testid="marker-toolbar"]').count();
report.chatSidebar = await page.locator(".chat-provider").count();
report.prodStoreAbsent = await page.evaluate(() => typeof window.__canvasStore === "undefined");
report.devPromptProbeAbsent = await page.evaluate(() => typeof window.__lastAiPrompt === "undefined");

// AI 通道：打包后密钥仍从 ~/.dsh 读，provider 列表应能返回
report.providers = await page.evaluate(async () => {
  try {
    const list = await window.shell.ai.listProviders();
    return list.map((p) => `${p.id}:${p.available}`).join(" ");
  } catch (e) {
    return `ERROR ${e.message}`;
  }
});

// 持久化：加个节点，等自动保存，看数据目录
await page.locator('[data-testid="add-node"]').click();
await page.waitForTimeout(250);
await page.locator('.canvas-menu button[data-kind="whiteboard"]').click();
await page.waitForTimeout(2800);
const snap = `${DATA}/canvas/document.json`;
report.snapshotWritten = fs.existsSync(snap);
if (report.snapshotWritten) {
  const doc = JSON.parse(fs.readFileSync(snap, "utf8"));
  report.snapshot = { revision: doc.revision, nodes: doc.nodes.length, markers: (doc.markers ?? []).length };
}
report.statusText = await page.locator(".canvas-statusbar").textContent();
report.stderrTail = err.split("\n").filter(Boolean).slice(0, 6).join(" | ") || "(空)";

await page.screenshot({ path: "D:/DoubaoWorkClone/.verify/shots-p6/packaged.png" });
console.log(JSON.stringify(report, null, 2));

await browser.close();
child.kill();
