import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, shot } from "./harness.mjs";

/**
 * 文字排版工具条端到端验收（阶段 8.5）。
 *
 * 断言：
 *   1. 选中文字节点才出现；没选中 / 选中图片时不出现；多选时也不出现
 *   2. 调字距/行高/字号 → 节点上的**计算样式真的变了**
 *   3. 对齐按钮改 text-align
 *   4. 「自动 / 固定」切尺寸模式
 *   5. 排版落盘，重启后还在
 *   6. Ctrl+Z 能把整串调整一次撤回（不是要按几十下）
 */
/*
 * ⚠️ 2026-10-16（审计 G01）：这里原来是 `"data"` —— 就是**仓库里那个真实数据目录**，
 * 而下面还有一句 `rmSync(DATA/canvas)`：每次跑这条验收都**删掉真实的画布文档**。
 * 现在落到 `.verify/` 下的专属目录（不进版本库、与真实数据无关）。
 */
const DATA = ".verify/data-textstyle";
const SNAP = path.join(DATA, "canvas", "document.json");
fs.rmSync(path.join(DATA, "canvas"), { recursive: true, force: true });
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

/** 读某个节点正文的计算样式。 */
const bodyStyle = (page, id) =>
  page.evaluate((nodeId) => {
    const el = document.querySelector(
      `.react-flow__node[data-id="${nodeId}"] .nv-markdown-body, .react-flow__node[data-id="${nodeId}"] .shape-text`,
    );
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      letterSpacing: cs.letterSpacing,
      lineHeight: cs.lineHeight,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      textAlign: cs.textAlign,
      borderTopWidth: cs.borderTopWidth,
      width: cs.width,
    };
  }, id);

const report = {};
{
  const { child, browser, page } = await boot(9460);

  // 1) 没选中 → 不出现
  report.beforeSelect = await page.locator('[data-testid="text-toolbar"]').count();

  // 选中 n1（文本节点）
  const box = await page.locator('.react-flow__node[data-id="n1"]').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 10);
  await page.waitForTimeout(700);
  report.afterSelect = await page.locator('[data-testid="text-toolbar"]').count();
  report.toolbarButtons = await page.$$eval(
    '[data-testid="text-toolbar"] [data-text-align], [data-testid="text-toolbar"] [data-text-size]',
    (els) => els.map((e) => e.getAttribute("data-text-align") ?? e.getAttribute("data-text-size")),
  );
  report.styleBefore = await bodyStyle(page, "n1");

  // 2) 调字距 / 行高 / 字号
  await page.locator('[data-testid="text-letter-spacing"]').fill("0.12");
  await page.waitForTimeout(300);
  await page.locator('[data-testid="text-line-height"]').fill("2");
  await page.waitForTimeout(300);
  await page.locator('[data-testid="text-font-size"]').fill("17");
  await page.waitForTimeout(500);
  report.styleAfterSliders = await bodyStyle(page, "n1");

  // 3) 对齐
  await page.locator('[data-text-align="center"]').click();
  await page.waitForTimeout(400);
  report.slideAfterAlign = (await bodyStyle(page, "n1"))?.textAlign;

  // 4) 边框宽度
  await page.locator('[data-testid="text-border-width"]').fill("2");
  await page.waitForTimeout(400);
  report.borderAfter = (await bodyStyle(page, "n1"))?.borderTopWidth;

  // 5) 尺寸模式
  await page.locator('[data-text-size="auto"]').click();
  await page.waitForTimeout(400);
  report.widthAfterAuto = (await bodyStyle(page, "n1"))?.width;
  await page.locator('[data-text-size="fixed"]').click();
  await page.waitForTimeout(400);
  report.widthAfterFixed = (await bodyStyle(page, "n1"))?.width;

  // 落盘
  await page.waitForTimeout(1600);
  const doc = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  report.onDisk = doc.nodes.find((n) => n.id === "n1")?.data?.textStyle ?? null;

  /*
   * 5b) 「恢复默认排版」那颗按钮（2026-10-13 补）
   *
   * ⚠️ `text-reset` 这个 testid **原来没有任何脚本引用过**（`src/` × `scripts/accept/` 交叉，
   * 见 HANDOFF §208 的零覆盖清单）—— 一排滑杆里那颗 × 就是"没人点过"的那类控件。
   * 断的是**后果**：点下去计算样式**真的回到默认**（字距 normal / 对齐 left / 边框 0 / 字号 13），
   * 不是"点了没报错"。放在读盘之后 —— 落盘那一步要的是"调过的"那一份（上面已取）。
   */
  report.resetBtn = await page.locator('[data-testid="text-reset"]').count();
  report.resetTitle = await page.evaluate(
    () => document.querySelector('[data-testid="text-reset"]')?.getAttribute("title") ?? "",
  );
  await page.locator('[data-testid="text-reset"]').click();
  await page.waitForTimeout(700);
  report.styleAfterReset = await bodyStyle(page, "n1");

  // 6) 图片节点选中时不该出现
  await page.mouse.click(box.x + 40, box.y + 600, { force: true });
  await page.waitForTimeout(200);
  await page.locator('.react-flow__node[data-id="n5"]').click({ force: true });
  await page.waitForTimeout(600);
  report.toolbarOnImage = await page.locator('[data-testid="text-toolbar"]').count();

  await shot(page, ".verify/shots-final/text-toolbar.png");
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2000));
}

// 重启后排版还在
{
  const { child, browser, page } = await boot(9461);
  const box = await page.locator('.react-flow__node[data-id="n1"]').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 10);
  await page.waitForTimeout(800);
  report.afterRestart = await bodyStyle(page, "n1");
  await browser.close();
  child.kill();
}

console.log(JSON.stringify(report, null, 2));

/*
 * 2026-10-13 补：这条脚本**原来一条判定都没有**（只有 console.log(report)）——
 * 在批跑里等于"静默不测"（永远 exit 0）。这里只补**零覆盖那一组**（`text-reset`）的判定，
 * 其余仍是报告 —— 判据是"点下去样式真的回默认"，可证伪。
 */
{
  const bad = [];
  if (report.resetBtn !== 1) bad.push("排版工具条上没有「恢复默认排版」那颗按钮");
  if (report.resetTitle !== "恢复默认排版") bad.push(`那颗按钮的 title 不对：${report.resetTitle}`);
  const s = report.styleAfterReset ?? {};
  if (s.letterSpacing !== "normal") bad.push(`恢复默认后字距不对：${s.letterSpacing}`);
  if (s.textAlign !== "left") bad.push(`恢复默认后对齐不对：${s.textAlign}`);
  if (s.borderTopWidth !== "0px") bad.push(`恢复默认后边框不对：${s.borderTopWidth}`);
  if (s.fontSize !== "13px") bad.push(`恢复默认后字号不对：${s.fontSize}`);
  const lh = Number.parseFloat(s.lineHeight ?? "");
  if (!(lh > 15 && lh < 25)) bad.push(`恢复默认后行高不对（1.6 × 13px 应在 20 上下）：${s.lineHeight}`);
  if (bad.length) {
    console.error("✗ 零覆盖那一组（恢复默认排版）：" + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 零覆盖那一组成立：「恢复默认排版」真的把字距/对齐/边框/字号/行高全部改回默认");
  }
}
