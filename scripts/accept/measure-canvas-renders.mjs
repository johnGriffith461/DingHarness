import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 画布重渲染**测量**工具（不是验收 —— 它没有判定，只出数字）。
 *
 * ## 为什么单独一条
 * §C6-5 的规矩是"先量再改"：加 `React.memo` 之前得先知道一次拖动到底
 * 引起多少次重渲染，否则"加了 memo"只是感觉上更快。
 * 这条脚本量**同一个构建**下的三个数字：
 *
 *   ① 静止基线：什么也不做，等同样时长 —— 这段时间的渲染是画布自己的噪音
 *   ② 拖动一次节点：从按下到松开，跨约 15 个 mousemove
 *   ③ 同一次拖动里"没被拖的那些节点"渲染了几次（memo 该救的就是这个数）
 *
 * 计数靠产物里的 `window.__renderProbe`（`src/canvas/renderProbe.ts`），
 * 所以**跑之前必须 `npm run electron:build`** —— 量的必须是打包产物。
 *
 * 用法：node scripts/accept/measure-canvas-renders.mjs
 *   出口永远是 0（测量不改判定）；数字打到 stdout，原始数据落
 *   `.verify/measure-canvas-renders.json`。
 */

const PORT = 9712;
const DATA = "D:/DoubaoWorkClone/.verify/measure-renders";
const OUT = "D:/DoubaoWorkClone/.verify/measure-canvas-renders.json";

fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_CANVAS_DATA_DIR = DATA;

const child = spawn(
  "D:/DoubaoWorkClone/node_modules/electron/dist/electron.exe",
  [".", `--remote-debugging-port=${PORT}`],
  { cwd: "D:/DoubaoWorkClone", env, stdio: ["ignore", "pipe", "pipe"] },
);
/* 不读管道会把自己憋死（见 harness.ts 里 §137 那条注释），这里只留尾部。 */
let log = "";
const cap = (d) => {
  log += d;
  if (log.length > 8192) log = log.slice(-4096);
};
child.stdout?.on("data", cap);
child.stderr?.on("data", cap);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connected = await (async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  return false;
})();

if (!connected) {
  console.error("✗ 调试端口没开，启动日志尾部：\n" + log);
  process.exit(0);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const pages = browser.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
await page.waitForSelector('[data-testid="wb"]', { timeout: 20000 });
await sleep(1500);

/* 打开画布（没开就点开关）。 */
if ((await page.locator('[data-testid="wb-canvas"]').count()) === 0) {
  await page.locator('[data-testid="wb-canvas-toggle"]').click();
  await sleep(2500);
}
await page.waitForSelector(".react-flow__node", { timeout: 20000 });
await sleep(1200);

/** 置位探针并清表。 */
const arm = () =>
  page.evaluate(() => {
    window.__renders = {};
    window.__renderProbe = true;
  });

const read = () => page.evaluate(() => ({ ...(window.__renders ?? {}) }));

/**
 * 一次拖动：按住某个节点的标题栏，移动 N 步，松开。
 *
 * 返回**实际位移**：不验位移的话，"拖动"可能压根没拖动（鼠标落到了别的元素上、
 * 或者被上层节点挡住）—— 那时渲染次数当然少，看着像优化成功，其实是没测到。
 * 第一版就是这样：③ 只有 3 次渲染，我差点当成"第二次拖动更省"。
 */
async function dragOnce(nodeIndex, steps, dx) {
  const before = await page.locator(".react-flow__node").nth(nodeIndex).boundingBox();
  const box = before;
  if (!box) throw new Error(`第 ${nodeIndex} 个节点没有 boundingBox`);
  /* 从标题栏拖（正文区可能是可编辑的，会吃掉拖动）。 */
  const x0 = box.x + Math.min(60, box.width / 2);
  const y0 = box.y + 12;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(x0 + (dx * i) / steps, y0 + (16 * i) / steps);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(250);
  const after = await page.locator(".react-flow__node").nth(nodeIndex).boundingBox();
  const moved = after && before ? Math.round(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)) : -1;
  /* 位移小于 4px 就当没动 —— 那次数字不算数（下面会标出来）。 */
  return { moved, reallyMoved: moved >= 4 };
}

const nodeCount = await page.locator(".react-flow__node").count();

/* ① 静止基线：等 1.2 秒，什么都不做。 */
await arm();
await sleep(1200);
const idle = await read();

/* ② 拖动一次（15 步）。 */
await arm();
const t0 = Date.now();
const move1 = await dragOnce(0, 15, 240);
const dragMs = Date.now() - t0;
const drag = await read();

/* ③ 换个节点再来一次（一次数字可能是巧合）。 */
await arm();
const move2 = await dragOnce(nodeCount - 1, 15, -180);
const drag2 = await read();

await page.screenshot({ path: "D:/DoubaoWorkClone/.verify/measure-renders-shot.png" });

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const report = {
  at: new Date().toISOString(),
  nodeCount,
  /* 位移（-1 = 量不到）：小于 4px 的那次数字不算数。 */
  moved: [move1.moved, move2.moved],
  reallyMoved: [move1.reallyMoved, move2.reallyMoved],
  idle,
  idleTotal: sum(idle),
  drag,
  dragTotal: sum(drag),
  drag2,
  drag2Total: sum(drag2),
  dragMs,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");

const row = (name, o) =>
  `${name.padEnd(18)} 合计 ${String(sum(o)).padStart(4)}  ` +
  Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
console.log(`画布节点数：${nodeCount}（拖动耗时 ${dragMs}ms，15 步）`);
if (!move1.reallyMoved) console.warn(`⚠️ ② 那次拖动只移动了 ${move1.moved}px —— 这组数字不算数`);
if (!move2.reallyMoved) console.warn(`⚠️ ③ 那次拖动只移动了 ${move2.moved}px —— 这组数字不算数`);
console.log(row("① 静止 1.2s", idle));
console.log(row("② 拖动 #0", drag));
console.log(row("③ 拖动 #1", drag2));
console.log("原始数据：" + OUT);

await browser.close();
child.kill();
await sleep(600);
process.exit(0);
