import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { NO_PAGE_HINT, bootApp, connectWithRetry, freshDir, killTree, openCanvas, shot, waitForPage } from "./harness.mjs";

/**
 * 验收：**坏掉的画布文档不许把画布弄崩**（§181）。
 *
 * ## 这条**不调模型**（进批跑）
 *
 * 种一个"半坏"的 `canvas/document.json`：
 * - 一个**正常**节点（该显示）
 * - 一个**缺 position** 的节点（该显示 —— **挪到原点，不丢内容**）
 * - 一个**类型不认识**的节点（该丢 —— 没有对应的渲染组件）
 * - 一条**好的连线**（该留着）
 * - 一条**悬空连线**（该丢 —— react-flow 会因为它报错）
 * - 一个形状不对的标注（该丢）
 *
 * 断言：**画布打得开**、两个好节点在、坏的没进画布、**渲染期无报错**、
 * 并且界面上**如实说了有东西读不进来**（静默吞掉最坏）。
 */
const DATA = ".verify/canvasbad-data";
if (!(await freshDir(DATA))) {
  console.error("✗ 数据目录 " + DATA + " 删不掉 —— 先手工关掉占着它的 Electron");
  process.exit(1);
}
const CANVAS = path.join(DATA, "canvas");
fs.mkdirSync(CANVAS, { recursive: true });

fs.writeFileSync(
  path.join(CANVAS, "document.json"),
  JSON.stringify(
    {
      version: 2,
      revision: 3,
      confirmedRevision: 3,
      updatedAt: new Date().toISOString(),
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: "good", type: "markdown", position: { x: 40, y: 60 }, data: { text: "好节点", title: "文本" } },
        { id: "nopos", type: "markdown", data: { text: "缺位置但有内容", title: "文本" } },
        { id: "weird", type: "什么节点", position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [
        { id: "e-good", source: "good", target: "nopos" },
        { id: "e-dangle", source: "good", target: "不在画布上" },
      ],
      markers: [{ id: "m-bad", kind: "rect", points: [] }],
    },
    null,
    2,
  ),
  "utf8",
);

const PORT = 9333;
const out = {};
let child = null;
let ok = false;
let getLog = () => "";

const boot = async () => {
  const r = await bootApp({ port: PORT, dataDir: DATA, timeoutMs: 30000 });
  child = r.child;
  ok = r.ok;
  getLog = r.getLog;
  return ok;
};

try {
  if (!(await boot())) {
    console.error("[诊断] 应用输出尾部：\n" + (getLog() || "(空)").slice(-1200));
    await killTree(child);
    process.exit(1);
  }

  const b = await connectWithRetry(chromium, `http://127.0.0.1:${PORT}`);
  const page = await waitForPage(b);
  if (!page) throw new Error(NO_PAGE_HINT);
  await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  /* 打开画布（照已有验收：`wb-canvas-toggle`） */
  await openCanvas(page);
  await page.waitForTimeout(2500);

  out.canvasShown = (await page.locator(".react-flow").count()) > 0;
  /* react-flow 给每个节点带 `data-id` */
  out.nodeIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".react-flow__node")).map((e) => e.getAttribute("data-id") ?? ""),
  );
  /* 连线（好的那条应当留着） */
  out.edgeIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".react-flow__edge")).map((e) => e.getAttribute("data-id") ?? ""),
  );
  /* 界面上有没有如实说"有东西没读进来" */
  out.bodyText = await page.evaluate(() => (document.body.textContent ?? "").replace(/\\s+/g, " ").slice(0, 900));
  out.errors = errors;
  out.shot = await shot(page, "canvasbad.png");

  await b.close();
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await killTree(child);

  const bad = [];
  if (out.error) bad.push("异常: " + out.error);

  if (!out.canvasShown) bad.push("⭐ 画布打不开（坏文档把渲染带崩了）");
  const ids = out.nodeIds ?? [];
  if (!ids.includes("good")) bad.push(`正常节点没显示：${JSON.stringify(ids)}`);
  if (!ids.includes("nopos")) bad.push(`⭐ 缺 position 的节点被丢了（应当挪到原点保住内容）：${JSON.stringify(ids)}`);
  if (ids.includes("weird")) bad.push("⭐ 类型不认识的节点竟然进了画布（没有渲染组件）");
  if (ids.length !== 2) bad.push(`画布上应当只有 2 个节点：${JSON.stringify(ids)}`);

  if (!(out.edgeIds ?? []).includes("e-good")) bad.push(`好连线没显示：${JSON.stringify(out.edgeIds)}`);
  if ((out.edgeIds ?? []).includes("e-dangle")) bad.push("⭐ 悬空连线进了画布");

  if (!/读不进来|已跳过/.test(out.bodyText ?? "")) {
    bad.push("⭐ 丢了东西却没有告诉用户（静默吞掉最坏）");
  }
  if ((out.errors ?? []).length > 0) bad.push(`渲染期有报错：${JSON.stringify(out.errors)}`);

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 坏画布文档不崩成立：画布打得开 / 缺位置的挪到原点保住内容 / 坏类型与悬空连线被丢 / 如实告知 / 无报错");
  }
}
