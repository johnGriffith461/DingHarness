import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { bootApp, killLeftovers, killTree } from "./harness.mjs";

/**
 * 持久化端到端验收（PLAN 4.2 / 4.3 / 4.5）。
 *
 * 注意：这里跑的是**生产包**（loadFile(dist)），没有 dev 专用的 `window.__canvasStore`，
 * 所以断言一律读 DOM 与磁盘文件 —— 这也更接近用户真实看到的东西。
 *
 *   1. 首启 → 加两个节点 → 自动保存 → 状态栏"已保存"，磁盘出现快照
 *   2. 杀掉重开 → 上次的改动还在
 *   3. 伪造"未确认快照"→ 再开 → 回退到确认版并弹出提示
 */

const DATA = "D:/DoubaoWorkClone/data";
const SNAP = path.join(DATA, "canvas", "document.json");
const OUT = "D:/DoubaoWorkClone/.verify/shots-p4";
fs.mkdirSync(OUT, { recursive: true });
/*
 * 开机前先清残留（§137）。
 *
 * 单独跑时没有批跑器帮你清 —— 而残留实例会占住调试端口/句柄，让这一条报出
 * 看不懂的 `ws disconnected code=1006`。§135 也是同一类（`rmSync` 报 EPERM）。
 * 判据：**一条验收必须能独立跑通**，不能依赖"批跑器正好帮你清了"。
 */
await killLeftovers();
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;


async function boot(port) {
  /*
   * ⭐ 等端口，不等固定秒数（§137）。
   *
   * 这条脚本的形态是"自己 kill 一个实例、再自己 boot 下一个"。第二个实例起来时，
   * 第一个还没释放**单实例锁** → 第二个**直接自杀** → 调试端口从没打开 → ECONNREFUSED。
   * 机器有负载时这个竞态更容易输 —— 这正是 §119~§122 三轮都没查明原因的"批跑偶发红"。
   * `setTimeout(8000)` 赌的是"8 秒够久"，`waitForPort` 赌的是"端口开了没有"。
   */
  const { child, ok, getLog } = await bootApp({ port, dataDir: DATA, timeoutMs: 30000 });
  if (!ok) {
    /*
     * 失败时**把应用自己的输出带出来**。
     * （我在 §137 一度把原因写成"被单实例锁挡住"，后来实测证明**这个项目根本没有
     *  requestSingleInstanceLock** —— 照抄那句会把人带沟里，所以现在只报事实 + 原始输出。）
     */
    console.error(`[诊断] ${port} 端口 30 秒内没打开。应用输出尾部：\n` + (getLog() || "(空)").slice(-1200));
    throw new Error(`实例没起来：调试端口 ${port} 30 秒内没打开`);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = browser.contexts()[0].pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  await page.waitForSelector('[data-testid="wb"]', { timeout: 25000 });
  await page.waitForTimeout(1800);
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await page.waitForTimeout(1500);
  
  await page.waitForSelector(".react-flow__node", { state: "attached" });
  await page.waitForTimeout(2500);
  return { child, browser, page };
}

const snapshot = (page) =>
  page.evaluate(() => ({
    nodes: document.querySelectorAll(".react-flow__node").length,
    edges: document.querySelectorAll(".react-flow__edge").length,
    types: Array.from(document.querySelectorAll(".react-flow__node .nv")).map(
      (el) => (el.className.match(/nv-(markdown|code|image|mindmap|mermaid|whiteboard)/) ?? [])[1] ?? "?",
    ),
    saveText: document.querySelector(".status-save")?.textContent?.trim() ?? null,
    toast: document.querySelector(".canvas-toast")?.textContent?.trim() ?? null,
  }));

const report = {};

// ---------- 第一次启动：加两个节点，等自动保存 ----------
{
  const { child, browser, page } = await boot(9270);
  report.first = await snapshot(page);

  await page.locator('[data-testid="add-node"]').click();
  await page.waitForTimeout(250);
  await page.locator('.canvas-menu button[data-kind="whiteboard"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="add-node"]').click();
  await page.waitForTimeout(250);
  await page.locator('.canvas-menu button[data-kind="mermaid"]').click();
  await page.waitForTimeout(2600); // 自动保存 800ms + ack

  report.afterEdit = await snapshot(page);
  report.docOnDisk = fs.existsSync(SNAP);
  if (report.docOnDisk) {
    const doc = JSON.parse(fs.readFileSync(SNAP, "utf8"));
    report.diskDoc = {
      version: doc.version,
      revision: doc.revision,
      confirmedRevision: doc.confirmedRevision,
      nodes: doc.nodes.length,
      edges: doc.edges.length,
      viewport: doc.viewport,
      nodeTypes: doc.nodes.map((n) => n.type),
    };
    report.revisionFiles = fs
      .readdirSync(path.join(DATA, "canvas"))
      .filter((f) => f.startsWith("rev-"))
      .sort();
  }
  await page.screenshot({ path: `${OUT}/01-saved.png` });
  await browser.close();
  await killTree(child);
}

// ---------- 第二次启动：应恢复 ----------
{
  const { child, browser, page } = await boot(9271);
  report.second = await snapshot(page);
  await page.screenshot({ path: `${OUT}/02-restored.png` });
  await browser.close();
  await killTree(child);
}

// ---------- 第三次：伪造未确认快照 → 应回退并提示 ----------
{
  const doc = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  const confirmedRevision = doc.confirmedRevision;
  const goodNodes = doc.nodes.length;

  const fake = { ...doc, revision: doc.revision + 5, nodes: doc.nodes.slice(0, 2) };
  fs.writeFileSync(SNAP, JSON.stringify(fake), "utf8");

  const { child, browser, page } = await boot(9272);
  report.third = { ...(await snapshot(page)), confirmedRevisionBeforeFake: confirmedRevision, goodNodes, fakedNodes: 2 };
  await page.screenshot({ path: `${OUT}/03-recovered.png` });
  await browser.close();
  child.kill();
}

console.log(JSON.stringify(report, null, 2));