// 开箱冒烟：**一次启动**走完主路径各一条最小通路 —— M0 工单 4 机制 2。
//
// 工单原话：「install → launch → 主路径点击，覆盖窗口操作、左右栏、画布、摘要、
// 设置对话框各一条最小路径」。
//
// 为什么它和那几十条 `accept-*` 不重复：那些各管一块，一条坏了只红它自己；
// 这一条问的是**"装完能不能用"** —— 它刻意只走一步一层，坏在任何一格都说明"开箱就坏了"。
// 所以它**不追求覆盖率**（那是 `accept-*` 的事），只追求"最短路径上没有任何一格是死的"。
//
// ⚠️ 每一格都**自己接住异常**：一条冒烟的用处在于"哪几格坏了"，
// 不该在第一格就抛出去（那样后面全不跑，等于没有信息）。超时也算那一格坏了。
//
// ⚠️ 导航顺序也是判据的一部分（写这条时踩了两次，都是我的顺序错、不是产品坏）：
//   · 左栏那颗按钮**不在首页**（工单列的是 云盘 / 插件 / 定时任务 / 手机遥控 / 任务视图 + 任务中心；
//     ⚠️ 2026-10-16 云盘整页拆了，所以现在借**插件**页做这一格）；
//   · 画布入口 `wb-skills` 在**输入区**里，只有在首页 / 任务视图才有。
//   所以顺序是：首页 → 插件（左栏）→ 回首页（画布）→ 设置 → 主路径。
//
// ⚠️ 它不调模型：全走本地 UI 与空态。`DSH_NO_REAL_MODEL` 在 CI 上兜底。
import { chromium } from "playwright";
import { openApp, sleep, killLeftovers, pickPort, openCanvas, closeCanvas, openSummary } from "./harness.mjs";

const bad = [];
let count = 0;

/** 跑一格：异常（含 locator 超时）算这一格坏了，继续往下跑。 */
async function step(name, fn) {
  count += 1;
  try {
    const detail = await fn();
    console.log(`   ✓ ${name}${detail ? "  —— " + detail : ""}`);
  } catch (error) {
    const msg = String(error?.message ?? error)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      // 多取两行：Playwright 超时的第一行只有"超时"，**被等的是哪个选择器写在 Call log 里** ——
      // 只截第一行等于把最有用的信息丢掉（这条我踩过）。
      .slice(0, 3)
      .join(" ⏐ ")
      .slice(0, 220);
    bad.push(`${name}（${msg}）`);
    console.log(`   ✗ ${name}  —— ${msg}`);
  }
}

const port = await pickPort([9911]);
await killLeftovers();
const { browser, page, getLog } = await openApp(chromium, {
  port,
  dataDir: ".verify/accept-smoke-data",
  cwd: ".",
});
await sleep(2200);

/* ① 起得来 */
await step("启动：工作台根节点出现", async () => {
  const n = await page.locator('[data-testid="wb"]').count();
  if (n !== 1) throw new Error(`wb 根节点 count=${n}`);
});

/* ② 窗口那条最小路径 */
await step("窗口：自绘标题栏 + 三个按钮 + 是拖动区", async () => {
  const w = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="wb-titlebar"]');
    return {
      bar: Boolean(bar),
      count: document.querySelectorAll('[data-testid="wb-winctl"] button').length,
      region: bar ? getComputedStyle(bar).getPropertyValue("-webkit-app-region").trim() : "",
    };
  });
  if (!w.bar) throw new Error("没有标题栏");
  if (w.count !== 3) throw new Error(`窗口按钮 ${w.count} 个（应当 3）`);
  if (w.region !== "drag") throw new Error(`标题栏不是拖动区（${w.region || "空"}）`);
  return `按钮 3 个 / app-region=${w.region}`;
});

/* ③ 左栏：收起 → 展开（在插件页做 —— 那颗按钮在页面头部，几个页面都有） */
await step("左栏：能收起能展开", async () => {
  await page.locator('[data-testid="wb-nav-plugins"]').click();
  await sleep(700);
  const width = () =>
    page.evaluate(() => {
      const n = document.querySelector('[data-testid="wb-nav"]');
      return n ? Math.round(n.getBoundingClientRect().width) : -1;
    });
  const w0 = await width();
  await page.locator('[data-testid="wb-nav-collapse"]').click();
  await sleep(350);
  const w1 = await width();
  await page.locator('[data-testid="wb-nav-collapse"]').click();
  await sleep(350);
  const w2 = await width();
  if (!(w0 > 0 && w1 === 0 && w2 === w0)) throw new Error(`宽度 ${w0} → ${w1} → ${w2}`);
  return `${w0} → ${w1} → ${w2}`;
});

/* ④ 右栏摘要：展开 → 收起 */
await step("右栏摘要：能展开能收起", async () => {
  const collapsed = () =>
    page.evaluate(() => {
      const a = document.querySelector('[data-testid="wb-summary"]');
      return a ? a.classList.contains("is-collapsed") : null;
    });
  const s0 = await collapsed();
  if (!(await openSummary(page))) throw new Error("展开失败（浮标点不开）");
  const s1 = await collapsed();
  await page.locator('[data-testid="wb-summary-collapse"]').click();
  await sleep(320);
  const s2 = await collapsed();
  if (!(s0 === true && s1 === false && s2 === true)) throw new Error(`收起=${s0} → 展开=${s1} → 收起=${s2}`);
  return `${s0} → ${s1} → ${s2}`;
});

/* ⑤ 画布：能开能关（回首页 —— 入口在输入区里） */
await step("画布：能开能关", async () => {
  await page.locator('[data-testid="wb-nav-home"]').click();
  await sleep(800);
  const opened = await openCanvas(page);
  const closed = await closeCanvas(page);
  if (!opened || !closed) throw new Error(`开=${opened} 关=${closed}`);
  return `开=${opened} 关=${closed}`;
});

/* ⑥ 设置对话框：能开能关 */
await step("设置对话框：能开能关", async () => {
  await page.locator('[data-testid="wb-account"]').click();
  await sleep(500);
  await page.locator('[data-testid="wb-acct-settings"]').click();
  await sleep(800);
  if ((await page.locator('[data-testid="wb-settings"]').count()) === 0) throw new Error("点「设置」没打开弹窗");
  /*
   * ⚠️ 这颗关闭键**没有 testid**（只有类名 `.wb-modal-close`，见 `SettingsDialog.tsx`）——
   * 第一版按 testid 找，于是超时；而弹窗没关掉又把后面那一步一起挡住
   * （全屏遮罩 `.wb-modal-mask` 会吃掉后面的点击）。所以这里按类名找，
   * **并且关不掉的后果是"后面全红"** —— 这正是冒烟要暴露的形状。
   */
  await page.locator(".wb-modal-close").first().click();
  await sleep(450);
  if ((await page.locator('[data-testid="wb-settings"]').count()) > 0) throw new Error("点关闭之后弹窗还在");
});

/* ⑦ 主路径：首页输入区在那儿，且能打字 */
await step("主路径：输入区能接收输入", async () => {
  await page.locator('[data-testid="wb-nav-home"]').click();
  await sleep(700);
  const composer = page.locator('[data-testid="wb-composer-input"], .wb-composer textarea, .wb-composer-input').first();
  if ((await composer.count()) === 0) throw new Error("没找到输入区");
  const kind = await composer.evaluate((el) =>
    el.tagName === "TEXTAREA" ? "textarea" : el.isContentEditable ? "editable" : "none",
  );
  if (kind === "none") throw new Error("输入区既不是 textarea 也不可编辑");
  await composer.click();
  await page.keyboard.type("冒烟检查");
  await sleep(250);
  const typed = await composer.evaluate((el) => (el.tagName === "TEXTAREA" ? el.value : (el.textContent ?? "")));
  if (!String(typed).includes("冒烟检查")) throw new Error(`打进去的字没读到（读到「${String(typed).slice(0, 12)}」）`);
  // 撤掉那几个字：这条只验"能打字"，不留副作用
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("Backspace");
  return `${kind}，能打字`;
});

console.log("");
if (bad.length) {
  console.error(`✗ 开箱冒烟：${count} 格里坏了 ${bad.length} 格 —— ${bad.join("；")}`);
  const log = getLog?.() ?? "";
  if (log) console.error("（应用日志尾部）\n" + log.slice(-800));
  process.exitCode = 1;
} else {
  console.log(`✓ 开箱冒烟：${count} 格全通（启动 → 窗口 → 左栏 → 右栏摘要 → 画布 → 设置 → 主路径）`);
}

await browser.close();
await killLeftovers();
