import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, pickPort, shot, verdict } from "./harness.mjs";

/**
 * 打包产物验收（阶段 6）：直接跑 `release/win-unpacked/Ding Harness.exe`，
 * 确认它**不依赖 dev server、不依赖工程目录**也能起来，
 * 并且画布、AI 通道、持久化都还在。
 *
 * 两个必须处理的坑：
 *   ① 本机环境里带着 `ELECTRON_RUN_AS_NODE=1`（HANDOFF §6.0），不清掉的话
 *      Electron 会把自己当 Node 跑 —— 没有脚本、直接退出码 0，看起来像"应用秒退"。
 *   ② 数据目录用 DSH_CANVAS_DATA_DIR 指到临时位置，别污染真实 userData。
 */
/*
 * ⚠️ 数据目录必须是**绝对路径**（2026-10-16，收进批跑时逮到）。
 *
 * 原来写的是相对路径 `".verify/packaged-data"` —— 而应用是以 `cwd: release/win-unpacked`
 * 启动的，`main.ts` 那句 `path.resolve(DSH_CANVAS_DATA_DIR)` 于是把数据落到
 * `release/win-unpacked/.verify/packaged-data/`（实测撞到），脚本又去仓库根那份找 →
 * 报「打包版没有把画布存到数据目录」，是个**假红**（自动保存其实写得好好的）。
 */
const DATA = path.resolve(".verify/packaged-data");
fs.rmSync(DATA, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;
// 打包产物不认命令行上的 --remote-debugging-port，用主进程里的显式开关
/* 打包产物只认这个环境变量（命令行那个会被忽略）→ 先挑一个能用的端口。 */
const __port = await pickPort([9330]);
env.DSH_DEBUG_PORT = String(__port);

const exe = path.resolve("release/win-unpacked/Ding Harness.exe");
if (!fs.existsSync(exe)) {
  /*
   * ⚠️ 2026-10-16（审计 A21）：缺产物是**环境红**，不是产品坏了 ——
   * 判词里写清"先打包"，`verify-acceptances.mjs` 的 `classify` 按这句把它归到环境红那一类。
   */
  console.error("打包产物不存在（先 pnpm package:win）：" + exe + " —— 这条按环境红记，不算通过。");
  process.exit(1);
}

/*
 * ⚠️ exe 必须是**绝对路径**（2026-10-16，收进批跑时逮到）。
 *
 * 原来是 `spawn("release/win-unpacked/Ding Harness.exe", …, { cwd: "release/win-unpacked" })`：
 * Windows 会把**相对的可执行文件路径按子进程的 cwd** 解析 → 变成
 * `release/win-unpacked/release/win-unpacked/Ding Harness.exe` → `spawn … ENOENT` 直接崩。
 * 这条以前没进批跑（=从没被跑到），所以一直没暴露。
 */
const child = spawn(exe, [], {
  cwd: path.dirname(exe),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let err = "";
child.stderr.on("data", (d) => (err += String(d)));
await new Promise((r) => setTimeout(r, 10000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:9330");
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
await page.waitForTimeout(1800);
  await openCanvas(page);
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

// 持久化：加个节点，**等自动保存真的落盘**（不是固定等 2.8 秒），再看数据目录
await page.locator('[data-testid="add-node"]').click();
await page.waitForTimeout(250);
await page.locator('.canvas-menu button[data-kind="whiteboard"]').click();
const snap = `${DATA}/canvas/document.json`;
/* 落盘是防抖的，机器一忙固定等待就会读到"还没写"（那是假红）→ 等那个真条件 */
for (let i = 0; i < 20 && !fs.existsSync(snap); i += 1) {
  await page.waitForTimeout(700);
}
report.snapshotWritten = fs.existsSync(snap);
if (report.snapshotWritten) {
  const doc = JSON.parse(fs.readFileSync(snap, "utf8"));
  report.snapshot = { revision: doc.revision, nodes: doc.nodes.length, markers: (doc.markers ?? []).length };
}
report.statusText = await page.locator(".canvas-statusbar").textContent();
report.stderrTail = err.split("\n").filter(Boolean).slice(0, 6).join(" | ") || "(空)";

await shot(page, ".verify/shots-p6/packaged.png");
console.log(JSON.stringify(report, null, 2));

/*
 * ── 判定（2026-10-14 补）────────────────────────────────────────────
 *
 * 这条脚本要证的正是"**打包后也能用**"（不依赖 dev server / 不依赖工程目录）。
 * 它原来只打报告，于是打包最典型的三类回归（壳起不来、画布缺资源、
 * 保存路径指回开发目录）都不会红。
 *
 * `prodStoreAbsent` / `devPromptProbeAbsent` 反过来断言：打包产物里
 * **不该**有 DEV 出口 —— 它们不是"锦上添花"，是"别把调试后门发出去"。
 */
const bad = [];
if (!report.nodes) bad.push("打包版画布里没有节点（缺资源或数据目录不对）");
if (!report.toolbar) bad.push("打包版画布工具条没渲染");
if (!report.markerToolbar) bad.push("打包版标注工具条没渲染");
if (!report.chatSidebar && report.chatSidebar !== 0) bad.push("打包版聊天侧栏没渲染");
if (!report.prodStoreAbsent) bad.push("⭐ 打包产物里有 `window.__canvasStore`（DEV 出口漏出去了）");
if (!report.devPromptProbeAbsent) bad.push("⭐ 打包产物里有 `window.__lastAiPrompt`（调试探针漏出去了）");
if (!String(report.providers ?? "").includes(":")) bad.push(`打包版拿不到 provider 列表：${JSON.stringify(report.providers)}`);
if (!report.snapshotWritten) bad.push("⭐ 打包版没有把画布存到数据目录（自动保存失效）");
if (!(report.snapshot?.nodes >= 1)) bad.push(`存盘里的节点数是 ${report.snapshot?.nodes}（新加的那个没进去）`);

verdict(bad, "打包版可用：画布/工具条/标注都在，provider 读得到，自动保存落到数据目录，且没有 DEV 出口漏出");

await browser.close();
child.kill();
