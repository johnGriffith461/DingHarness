import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectWithRetry, openCanvas, shot, dismissFirstRunIfShown } from "./harness.mjs";

/**
 * 画框节点端到端验收（阶段 8.4，对标 `moveFrameWithChildren`）。
 *
 * 断言：
 *   1. 能建画框，DOM 带 `data-canvas-frame-id` / `data-frame-id`（原版契约）
 *   2. 把卡片拖进画框 → 它成为画框的子节点（`parentId` 指向画框）
 *   3. **拖画框 → 框住的卡片跟着走**（父子关系的意义就在这）
 *   4. 删掉画框 → 里面的卡片不会跟着消失（只是回到顶层）
 *   5. 画框随文档落盘、重启后还在
 */
/*
 * ⚠️ 2026-10-16（审计 G01）：这里原来是 `"data"` —— 就是**仓库里那个真实数据目录**，
 * 而下面还有一句 `rmSync(DATA/canvas)`：每次跑这条验收都**删掉真实的画布文档**。
 * 现在落到 `.verify/` 下的专属目录（不进版本库、与真实数据无关）。
 */
const DATA = ".verify/data-frames";
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
  await dismissFirstRunIfShown(page);
  await page.waitForTimeout(1800);
  await openCanvas(page);
  await page.waitForTimeout(1500);
  
  await page.waitForSelector(".react-flow__node", { state: "attached" });
  await page.waitForTimeout(2500);
  return { child, browser, page };
}

const readDoc = () => JSON.parse(fs.readFileSync(SNAP, "utf8"));
const report = {};

{
  const { child, browser, page } = await boot(9440);

  // 1) 建画框
  await page.locator('[data-testid="add-node"]').click();
  await page.waitForTimeout(300);
  await page.locator('.canvas-menu button[data-kind="frame"]').click();
  await page.waitForTimeout(1200);

  report.frameContract = await page.evaluate(() => {
    const el = document.querySelector(".frame-node");
    return el
      ? {
          frameId: el.getAttribute("data-canvas-frame-id"),
          legacyId: el.getAttribute("data-frame-id"),
          title: el.textContent?.trim().slice(0, 20),
        }
      : null;
  });

  // 2) 把某个卡片拖进画框中央
  const frameBox = await page.locator(".frame-node").boundingBox();
  const targetId = "n1";
  const nodeBox = await page.locator(`.react-flow__node[data-id="${targetId}"]`).boundingBox();
  await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(1500);

  // 让自动保存落盘后再看归属
  await page.waitForTimeout(1500);
  const doc1 = readDoc();
  const moved = doc1.nodes.find((n) => n.id === targetId);
  report.adoptedIntoFrame = moved?.parentId ?? null;
  report.frameIdFromDisk = doc1.nodes.find((n) => n.type === "frame")?.id ?? null;

  // 3) 拖画框 → 子节点应跟着走
  const before = await page.locator(`.react-flow__node[data-id="${targetId}"]`).boundingBox();
  const frameEl = await page.locator(".frame-node").boundingBox();
  // 抓画框的标题栏来拖（画框本体是 pointer-events:none，只有标题栏是拖拽把手）
  const titleBtn = await page.locator('[data-testid^="frame-drag-"]').boundingBox();
  await page.mouse.move(titleBtn.x + titleBtn.width / 2, titleBtn.y + titleBtn.height / 2);
  await page.mouse.down();
  await page.mouse.move(titleBtn.x + titleBtn.width / 2 + 120, titleBtn.y + titleBtn.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const after = await page.locator(`.react-flow__node[data-id="${targetId}"]`).boundingBox();
  report.moveWithChildren = {
    dx: Math.round(after.x - before.x),
    dy: Math.round(after.y - before.y),
    frameMoved: Math.abs((await page.locator(".frame-node").boundingBox()).x - frameEl.x) > 40,
  };

  await shot(page, ".verify/shots-final/frames.png");

  /*
   * ── 底部工具条那三颗（2026-10-13 补）──
   *
   * ⚠️ `bottom-undo` / `bottom-redo` / `bottom-marker` 这三个 testid
   * **原来没有任何脚本引用过**（`src/` × `scripts/accept/` 交叉，见 HANDOFF §208 的零覆盖清单）。
   * 底部工具条正属于"没人点过 ⇒ 烂了也没人知道"的那一类（§201）。
   * 断的是**后果**：刚拖过画框（一次可撤销的操作）→ 撤销键**必须变成可点**、
   * 重做键**必须还是禁用的**；「标记」点下去**画布真的进标记态**（`data-marker-tool` 从 off 变 rect）、
   * 再点一次真的退出来；一个标记都没画时「清空全部标记」**必须是禁用的**。
   *
   * ⚠️ 只按「标记」开关，**不点撤销**（那会改掉上面刚验过的位移）。
   */
  report.undoRedo = await page.evaluate(() => {
    const read = (id) => {
      const e = document.querySelector(`[data-testid="${id}"]`);
      return e ? { disabled: e.hasAttribute("disabled"), title: e.getAttribute("title") ?? "" } : null;
    };
    return { undo: read("bottom-undo"), redo: read("bottom-redo"), marker: read("bottom-marker") };
  });
  await page.locator('[data-testid="bottom-marker"]').click();
  await page.waitForTimeout(600);
  /*
   * ⚠️ 判据用**画布根上的 `data-marker-tool`**（画布自身的状态），不要数 `[data-testid="marker-toolbar"]`：
   * 那条工具条**一直都在 DOM 里**（CSS 也不按模式隐藏），数它等于永远为 1、什么也证明不了。
   */
  report.markerToolOn = await page.evaluate(
    () => document.querySelector("[data-canvas-keyboard-root]")?.getAttribute("data-marker-tool") ?? "",
  );
  /* 一个标记都没画 → 「清空全部标记」应当是**禁用**的（不给假按钮） */
  report.markerClear = await page.evaluate(() => {
    const e = document.querySelector('[data-testid="marker-clear"]');
    return e ? { disabled: e.hasAttribute("disabled"), title: e.getAttribute("title") ?? "" } : null;
  });
  await page.locator('[data-testid="bottom-marker"]').click();
  await page.waitForTimeout(500);
  report.markerToolOff = await page.evaluate(
    () => document.querySelector("[data-canvas-keyboard-root]")?.getAttribute("data-marker-tool") ?? "",
  );

  await page.waitForTimeout(1800);
  report.diskFrames = readDoc().nodes.filter((n) => n.type === "frame").length;
  await browser.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 2000));
}

// 4) 重启后画框还在
{
  const { child, browser, page } = await boot(9441);
  report.afterRestart = {
    frames: await page.locator(".frame-node").count(),
    adopted: await page.evaluate(() => {
      const el = document.querySelector(".frame-node");
      return el ? el.getAttribute("data-canvas-frame-id") : null;
    }),
  };
  await browser.close();
  child.kill();
}

console.log(JSON.stringify(report, null, 2));

/*
 * 2026-10-13 补：这条脚本**原来一条判定都没有**（只有 console.log(report)）——
 * 在批跑里等于"静默不测"（永远 exit 0）。这里只补**零覆盖那一组**
 * （底部工具条的撤销/重做/标记 + 标记工具条的「清空」）的判定，其余仍是报告。
 */
{
  const bad = [];
  if (!report.undoRedo?.undo) bad.push("底部工具条没有撤销键（bottom-undo）");
  else {
    if (report.undoRedo.undo.disabled) {
      bad.push("⭐ 刚拖过画框（可撤销的操作），撤销键却是禁用的");
    }
    if (!report.undoRedo.undo.title) bad.push("撤销键没有 title（说不出它干什么）");
  }
  if (!report.undoRedo?.redo) bad.push("底部工具条没有重做键（bottom-redo）");
  else if (!report.undoRedo.redo.disabled) bad.push("⭐ 什么都没撤销过，重做键却是可点的");
  if (!report.undoRedo?.marker) bad.push("底部工具条没有「标记」键（bottom-marker）");
  else if (!report.undoRedo.marker.title) bad.push("「标记」键没有 title");
  if (report.markerToolOn !== "rect") bad.push(`⭐ 点了「标记」画布没进标记态（data-marker-tool=${report.markerToolOn}）`);
  if (report.markerClear?.disabled !== true) {
    bad.push("⭐ 一个标记都没画，「清空全部标记」却可点（假按钮）");
  }
  if (report.markerToolOff !== "off") bad.push(`再点一次「标记」没退出标记态（data-marker-tool=${report.markerToolOff}）`);
  if (bad.length) {
    console.error("✗ 零覆盖那一组（底部工具条撤销/重做/标记 + 清空标记）：" + bad.join("；"));
    process.exitCode = 1;
  } else {
    console.log("✓ 零覆盖那一组成立：撤销/重做状态跟着历史走 / 「标记」能开能关 / 空标记时「清空」如实禁用");
  }
}
