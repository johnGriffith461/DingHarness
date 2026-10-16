import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { connectWithRetry, failOnMarks, openCanvas, pickPort, shot, verdict } from "./harness.mjs";

/* ⚠️ 2026-10-16（审计 G15）：这份脚本原来只把 ✗ 印出来、从不改退出码 —— 批跑里等于没测 */
failOnMarks();

/**
 * 代码节点的「复制」（§187 界面体检 P1 第 14 条点名的那一项）。
 *
 * ## 为什么单开一条
 * 这一项最容易做成**假按钮**：皮肤做齐、点下去什么都不发生（§124 死按钮审计
 * 报的就是这类）。所以断言只认**剪贴板里到底有没有那段代码**，
 * 以及有没有"已复制"的即时反馈 —— 不看按钮长什么样。
 *
 * ## 不连模型
 * 画布初始文档里就有一个代码节点（`initialGraph.ts`），复制它不需要任何 AI 通道。
 */
const DATA = ".verify/codecopy-data";
fs.rmSync(DATA, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

/* 这台机器的回环端口会随机连不上（见 harness.pickPort）→ 起之前先挑一个能用的。 */
const __port = await pickPort([12750]);
const child = spawn(
  "node_modules/electron/dist/electron.exe",
  [".", "--remote-debugging-port=" + __port],
  { cwd: ".", env, stdio: ["ignore", "ignore", "ignore"] },
);
await new Promise((r) => setTimeout(r, 9000));

const browser = await connectWithRetry(chromium, "http://127.0.0.1:" + __port);
const ctx = browser.contexts()[0];
await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
const pages = ctx.pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await page.waitForTimeout(1500);

const report = {};
try {
  report.step = "打开画布";
  if ((await page.locator('[data-testid="wb-canvas"]').count()) === 0) {
    await openCanvas(page);
    await page.waitForTimeout(2500);
  }
  await page.waitForSelector(".react-flow__node", { timeout: 20000 });
  await page.waitForTimeout(1200);

  /* 找一个代码节点：它的渲染器上有复制键 `nv-copy-<id>`。 */
  report.step = "找代码节点的复制键";
  const copySel = '[data-testid^="nv-copy-"]';
  report.copyButtons = await page.locator(copySel).count();
  const first = await page.locator(copySel).first().getAttribute("data-testid");
  report.firstId = first?.replace("nv-copy-", "") ?? null;

  /*
   * 先把这个节点显示在视图里再点 —— 画布初始文档里节点会互相重叠，
   * 不在视口里的那份点不着（Playwright 会等超时，报"元素不可见"）。
   */
  const nodeId = report.firstId;
  await page.evaluate((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    el?.scrollIntoView({ block: "center", inline: "center" });
  }, nodeId);
  await page.waitForTimeout(600);

  /* 剪贴板先清成一句哨兵，免得"上一次留下的内容"被误认成本次成功。 */
  await page.evaluate(() => navigator.clipboard.writeText("__sentinel__"));
  await page.waitForTimeout(300);

  report.step = "读节点里的代码原文";
  report.codeText = await page.evaluate((id) => {
    const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (!node) return null;
    const pre = node.querySelector(".nv-code-pre code") ?? node.querySelector("textarea");
    return pre ? (pre.textContent ?? "").slice(0, 200) : null;
  }, nodeId);

  report.step = "点复制";
  await page.locator(`[data-testid="nv-copy-${nodeId}"]`).click();
  await page.waitForTimeout(600);
  report.clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => "(读不到)"));
  /* 「已复制」的即时反馈：同一颗按钮上的 2 秒态 */
  report.okState = await page.locator(`[data-testid="nv-copy-${nodeId}"].is-ok`).count();
  report.titleWhileOk = await page.locator(`[data-testid="nv-copy-${nodeId}"]`).getAttribute("title");

  /* 2 秒后自己摘掉 —— 不常驻、也不飘 toast（这是设计选择，钉住免得以后被改坏） */
  await page.waitForTimeout(2400);
  report.okStateAfter = await page.locator(`[data-testid="nv-copy-${nodeId}"].is-ok`).count();

  await shot(page, ".verify/codecopy.png");
} catch (error) {
  report.error = `在「${report.step ?? "未知"}」这一步失败：${String(error).split(String.fromCharCode(10))[0]}`;
} finally {
  console.log(JSON.stringify(report, null, 2));

  const bad = [];
  if (report.error) bad.push(`异常：${String(report.error).slice(0, 200)}`);
  if (!report.copyButtons) bad.push("⭐ 画布上的代码节点没有复制入口（体检 P1 第 14 条那一项）");
  if (!report.codeText) bad.push("读不到代码节点里的正文（可能渲染器换过结构，断言会空转）");

  /* ① 真的写进了剪贴板，而且是**这个节点**的代码 */
  if (report.clipboard === "__sentinel__") bad.push("⭐ 点了复制但剪贴板没变（假按钮）");
  if (report.clipboard === "(读不到)") bad.push("读不到剪贴板（权限没给上，这条断言会空转）");
  const got = String(report.clipboard ?? "").trim();
  const want = String(report.codeText ?? "").trim();
  if (want && !got.startsWith(want.slice(0, 40))) {
    bad.push(`剪贴板里的不是这段代码：拿到 ${JSON.stringify(got.slice(0, 60))}`);
  }

  /* ② 有即时反馈，且**会自己消失**（常驻的成功态会让人以为一直复制着） */
  if (!report.okState) bad.push("复制后按钮上没有「已复制」的反馈（用户不知道成没成）");
  if (report.titleWhileOk !== "已复制") bad.push(`复制后按钮提示是 ${JSON.stringify(report.titleWhileOk)}（应写「已复制」）`);
  if (report.okStateAfter) bad.push("「已复制」态 2 秒后没摘掉（会一直挂着）");

  verdict(bad, "代码复制成立：剪贴板里就是这段代码 / 按钮给「已复制」反馈且 2 秒后复位 / 不是假按钮");

  await browser.close().catch(() => undefined);
  child.kill();
  process.exit(process.exitCode ?? 0);
}
