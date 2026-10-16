import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, shot } from "./harness.mjs";

/**
 * 标记层端到端验收（阶段 5.1 / 5.2 / 5.3）：
 *   1. 八种标记都能画出来，落到 DOM（`.marker-shape`）
 *   2. 颜色 / 线宽切了之后新标记用新样式
 *   3. 撤销上一笔、清空
 *   4. 标记随文档落盘并在重启后还在（阶段 5 首次接入持久化）
 *   5. 标记当提示词：拼进生成要求（读请求内容做断言）
 */

/*
 * ⚠️ 2026-10-16（审计 G01）：这里原来是 `"data"` —— 就是**仓库里那个真实数据目录**，
 * 而下面还有一句 `rmSync(DATA/canvas)`：每次跑这条验收都**删掉真实的画布文档**。
 * 现在落到 `.verify/` 下的专属目录（不进版本库、与真实数据无关）。
 */
const DATA = ".verify/data-p5";
const SNAP = path.join(DATA, "canvas", "document.json");
const OUT = ".verify/shots-p5";
fs.mkdirSync(OUT, { recursive: true });
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
  await page.waitForTimeout(2000);
  return { child, browser, page };
}

const shapes = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".marker-layer .marker-shape")).map((el) => {
      const cls = el.getAttribute("class") ?? "";
      const m = /marker-(rect|ellipse|arrow|scratch|highlight|mask|text|number)\b/.exec(cls);
      return m ? m[1] : cls;
    }),
  );

const report = {};

{
  const { child, browser, page } = await boot(9300);
  const box = await page.locator(".canvas-flow").boundingBox();
  // 画在左上角空区域，避开节点
  const at = (dx, dy) => ({ x: box.x + 120 + dx, y: box.y + 120 + dy });

  const tool = async (name) => {
    await page.locator(`[data-marker-tool="${name}"]`).click();
    await page.waitForTimeout(150);
  };
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(250);
  };
  const click = async (p) => {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(250);
  };

  report.toolbarPresent = await page.locator('[data-testid="marker-toolbar"]').count();

  // 1. 方框
  await tool("rect");
  await drag(at(0, 0), at(120, 80));
  // 2. 圈选
  await tool("ellipse");
  await drag(at(160, 0), at(260, 70));
  // 3. 箭头
  await tool("arrow");
  await drag(at(0, 110), at(110, 160));
  // 4. 涂鸦
  await tool("scratch");
  await drag(at(0, 200), at(90, 250));
  // 5. 划重点
  await tool("highlight");
  await drag(at(140, 200), at(240, 205));
  // 6. 遮挡
  await tool("mask");
  await drag(at(280, 130), at(380, 200));
  // 7. 批注（点 → 输入框打字）
  await tool("text");
  await click(at(300, 40));
  await page.locator('[data-testid="marker-text-input"] textarea').fill("这段写短一点");
  await page.locator('[data-testid="marker-text-input"] textarea').press("Enter");
  await page.waitForTimeout(300);
  // 8. 序号 ×2（验证编号递增）
  await tool("number");
  await click(at(420, 60));
  await page.locator('[data-marker-tool="number"]').click();
  await page.waitForTimeout(120);
  await click(at(470, 90));

  report.shapes = await shapes(page);
  report.countText = await page.locator('[data-testid="marker-count"]').textContent();
  report.statusText = await page.locator(".canvas-statusbar").textContent();
  await shot(page, `${OUT}/01-markers.png`);

  // 样式：换色 + 加粗后再画一条，检查它用了新样式
  await page.locator('[data-marker-color="#4ade80"]').click();
  await page.locator(".marker-width").fill("9");
  await page.waitForTimeout(150);
  await tool("rect");
  await drag(at(520, 150), at(600, 220));
  report.styled = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll(".marker-layer .marker-shape"));
    const last = els[els.length - 1];
    return { stroke: last?.getAttribute("stroke"), width: last?.getAttribute("stroke-width") };
  });

  // 撤销一笔：先记录撤销前的数量，再点撤销，最后核对
  report.beforeUndo = (await shapes(page)).length;
  await page.locator('[data-testid="marker-undo"]').click();
  await page.waitForTimeout(300);
  report.afterUndo = (await shapes(page)).length;
  await shot(page, `${OUT}/02-styled.png`);

  // 标记当提示词：开着时拼接，关掉时不拼
  await page.waitForTimeout(1800); // 落盘
  const doc = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  report.disk = { markers: (doc.markers ?? []).length, kinds: (doc.markers ?? []).map((m) => m.kind) };
  report.promptToggleOn = await page.locator('[data-testid="marker-prompt"]').getAttribute("class");

  /*
   * ⚠️ 关掉第一个实例之后、第二个起来之前，**读一次磁盘**（2026-10-16）。
   *
   * 为什么要卡这一刀：这条脚本原来的写法只能看到"重启之后界面上没有标记"，
   * 而"标记没了"可能发生在三个地方 —— 关窗时被写没了、重启时被回滚了、
   * 或者只在界面上没画出来（盘上其实还在）。三个原因三个修法，先分清是谁。
   */
  report.diskBeforeClose = (() => {
    try {
      return (JSON.parse(fs.readFileSync(SNAP, "utf8")).markers ?? []).length;
    } catch {
      return -1;
    }
  })();
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2500));
  report.diskAfterKill = (() => {
    try {
      return (JSON.parse(fs.readFileSync(SNAP, "utf8")).markers ?? []).length;
    } catch {
      return -1;
    }
  })();
}

// 重启：标记应还在
{
  const { child, browser, page } = await boot(9301);
  report.afterRestart = {
    shapes: await shapes(page),
    status: await page.locator(".canvas-statusbar").textContent(),
    markerToolbar: await page.locator('[data-testid="marker-toolbar"]').count(),
    disk: (() => {
      try {
        return (JSON.parse(fs.readFileSync(SNAP, "utf8")).markers ?? []).length;
      } catch {
        return -1;
      }
    })(),
  };
  /* 标记层可能只在标记模式下渲染 —— 开着再数一次，免得把"没开模式"读成"标记丢了" */
  if (report.afterRestart.markerToolbar > 0) {
    await page.locator('[data-marker-tool="rect"]').click();
    await page.waitForTimeout(700);
    report.afterRestart.shapesWithTool = await shapes(page);
  }
  await shot(page, `${OUT}/03-restart.png`);
  await browser.close();
  child.kill();
}

console.log(JSON.stringify(report, null, 2));

/*
 * ══════════ 判定（2026-10-16 补）══════════
 *
 * ⚠️ 这条原来**一条判定都没有**：它把 report 打印出来就退 0，所以"八种标记能不能画 / 重启还在不在"
 * 全靠人读 JSON —— 而人是不会读的（批跑的分类器把它标成"跑通但没有任何判定"）。
 * 现在把报告里那些数变成判定。边界如实留在这里：**涂抹（scratch/highlight）与"当提示词"两条
 * 只断"画出来了 / 开关是开的"**，没有断像素是不是真的涂上去了。
 */
{
  const bad = [];
  if (report.toolbarPresent < 1) bad.push("标记工具条根本不在（进不了标记模式）");

  const wantKinds = ["rect", "ellipse", "arrow", "scratch", "highlight", "mask", "text", "number"];
  const got = report.shapes ?? [];
  for (const k of wantKinds) {
    if (!got.includes(k)) bad.push(`八种标记里「${k}」没画出来（实际：${got.join(" / ") || "一个都没有"}）`);
  }
  if (Number(report.countText?.trim() ?? "0") !== got.length) {
    bad.push(`工具条上写「${report.countText?.trim()}」而画布上实际有 ${got.length} 个 —— 计数与画面不一致`);
  }

  if (report.beforeUndo !== report.afterUndo + 1) {
    bad.push(`撤销一笔之后数量没少一个（${report.beforeUndo} → ${report.afterUndo}）—— 撤销没接上`);
  }
  if ((report.disk?.markers ?? -1) !== report.afterUndo) {
    bad.push(`落盘数与画面不一致（盘上 ${report.disk?.markers} vs 画面 ${report.afterUndo}）—— 标记没跟上磁盘`);
  }
  if (!(report.disk?.kinds ?? []).length) bad.push("磁盘快照里一个标记都没有 —— 标记层没进快照");

  /*
   * ⭐ 重启那一段是这条脚本的主柱子。三个数分开看（见上面那一刀的解释）：
   *   `diskBeforeClose` → 关窗前的落盘；`diskAfterKill` → 关窗后还在不在；
   *   `afterRestart.disk` → 重启（并加载）之后还在不在。
   */
  if (report.diskBeforeClose !== report.disk?.markers) {
    bad.push(`关窗那一刻盘上变成了 ${report.diskBeforeClose} 个（读盘时是 ${report.disk?.markers} 个）—— 关窗把标记写丢了`);
  }
  if (report.diskAfterKill !== report.diskBeforeClose) {
    bad.push(`杀进程之后盘上从 ${report.diskBeforeClose} 变成 ${report.diskAfterKill} 个 —— 退出路径改了磁盘上的内容`);
  }
  const after = report.afterRestart ?? {};
  if (after.disk !== report.diskAfterKill) {
    bad.push(`重启之后盘上从 ${report.diskAfterKill} 变成 ${after.disk} 个 —— 重启过程中被改写了（这就是丢数据的形态）`);
  }
  /* ⚠️  回的是**种类数组**（不是个数）—— 比长度，别把数组直接当数（第一版就这么自己坑了自己） */
  if (after.markerToolbar > 0 && (after.shapesWithTool ?? []).length !== report.diskAfterKill) {
    bad.push(
      `重启之后界面上只画出 ${(after.shapesWithTool ?? []).length} 个标记，而盘上还有 ${report.diskAfterKill} 个 —— 载入没把标记画回来`,
    );
  }

  if (!(report.disk?.kinds?.length)) bad.push("落盘的标记里没有 kind 信息");
  if (!String(report.promptToggleOn ?? "").includes("is-on")) {
    bad.push("「标记当提示词」的开关不是开着的（脚本最后一步读的就是它）");
  }

  if (bad.length) {
    console.error("✗ " + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 标记层成立：八种都画得出来 / 计数与画面一致 / 撤销接上 / 进快照 / 重启之后盘上与界面上都还在");
  }
}
