// 右侧两个面板：开、关、反复开合、Esc —— M0 工单 2 的常驻回归。
//
// 判据来自工单 2.2 / 2.3：
//   · 关闭入口必须**可见且语义无歧义**（带字或公认图标）
//   · 两个右面板统一支持 **Esc 关闭**（键盘可达）
//   · 开、关、反复开合各 10 次，行为一致，无"关不掉"状态
//   · 把手类开关的热区**不得被吞**（10-14 在这种地方出过两次布局回归）
//
// ⚠️ 修前实测（2026-10-15，`.verify/m0/probe-panels.mjs`）留下的三条事实，别当成主张删掉：
//   ① 摘要面板**本来就能关**（10-14 那版已修：收起按钮带字「收起」）——它缺的只有 Esc；
//   ② 画布对话侧栏的把手**热区没被吞**（`elementFromPoint` 命中的就是它自己）、10 次开合一致；
//      它真正的毛病是**关的入口只有一颗 17px 的 `‹`** —— 像"往左导航"、容易看漏；
//   ③ 所以这一条的断言落在"入口可见/带字 + Esc + 往返一致"，不是"修一个关不掉的 bug"。
import { chromium } from "playwright";
import { openApp, sleep, killLeftovers, pickPort, openCanvas, openSummary } from "./harness.mjs";

const bad = [];
const note = (m) => console.log("   " + m);

const port = await pickPort([9881]);
await killLeftovers();
const { browser, page } = await openApp(chromium, {
  port,
  dataDir: ".verify/accept-panels-data",
  cwd: ".",
});
await sleep(1800);

/** 面板 A 的状态。 */
const summaryState = () =>
  page.evaluate(() => {
    const aside = document.querySelector('[data-testid="wb-summary"]');
    const btn = document.querySelector('[data-testid="wb-summary-edge"]');
    return {
      collapsed: aside ? aside.classList.contains("is-collapsed") : null,
      handle: Boolean(document.querySelector('[data-testid="wb-summary-expand"]')),
      collapseBtn: Boolean(btn),
      collapseText: (btn?.textContent ?? "").trim(),
    };
  });

/* ---------- 面板 A：对话摘要 ---------- */

const a0 = await summaryState();
if (a0.collapsed !== true) bad.push("摘要面板默认应当收起");
if (!a0.handle) bad.push("摘要面板收起时没有展开的浮标（那就打不开了）");
await openSummary(page);
const a1 = await summaryState();
if (a1.collapsed) bad.push("点浮标后摘要面板没有展开");
if (!a1.collapseBtn) bad.push("摘要面板展开后没有「收起」入口");
if (!/收起/.test(a1.collapseText)) {
  bad.push(`摘要面板的收起入口不带字（实测文字=「${a1.collapseText}」）—— 用户会认成"往右导航"`);
}

/*
 * **收起入口只许有一个**（2026-10-22 主人报的）：
 *   「点击完面板按钮之后会发现有两个收起按钮」——
 * 上一版为了"打开之后原位也能关"，在面板左缘又挂了一条竖排「收起」；
 * 而头部那颗带字的「收起」一直在。两个入口做同一件事，用户只会觉得乱。
 *
 * 现在的判据（与产品意图一致，不绑实现）：
 *   ① 展开时**恰好一个**可见的收起入口；
 *   ② 它必须带字（图标 + 「收起」），不能是一枚看不懂的箭头。
 */
const edgeState = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-testid="wb-summary"]');
    const buttons = [...document.querySelectorAll('[data-testid="wb-summary-edge"]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => ({
        testid: el.getAttribute("data-testid"),
        text: (el.textContent ?? "").replace(/\s+/g, "").trim(),
      }));
    return { count: buttons.length, buttons, panel: panel ? 1 : 0 };
  });
const e1 = await edgeState();
if (!e1.panel) bad.push("摘要面板没打开（无从判断收起入口）");
else if (e1.count === 0) bad.push("摘要面板展开后没有任何收起入口");
else if (e1.count > 1) bad.push(`摘要面板展开后有 ${e1.count} 个收起入口（${e1.buttons.map((b) => b.testid).join(" / ")}）—— 只要一个`);
else {
  const only = e1.buttons[0];
  if (!/收起/.test(only.text)) bad.push(`唯一那个收起入口不带字（实测=「${only.text}」）`);
  note(`摘要收起入口：恰好 1 个 ✓ / 带字「${only.text}」`);
}

// 往返 10 次
let aRound = 0;
for (let i = 0; i < 10; i += 1) {
  await openSummary(page);
  if ((await summaryState()).collapsed) break;
  await page.locator('[data-testid="wb-summary-edge"]').click();
  await sleep(200);
  if (!(await summaryState()).collapsed) break;
  aRound += 1;
}
if (aRound !== 10) bad.push(`摘要面板反复开合只有 ${aRound}/10 次一致`);
note(`摘要面板：默认收起 ✓ / 带字收起入口「${a1.collapseText}」/ 往返 ${aRound}/10`);

// Esc 收起
await openSummary(page);
await page.keyboard.press("Escape");
await sleep(350);
if (!(await summaryState()).collapsed) bad.push("摘要面板按 Esc 没有收起");
note(`摘要面板 Esc：${(await summaryState()).collapsed ? "✓ 收起了" : "✗ 没反应"}`);

/* ---------- 面板 B：画布对话侧栏 —— 已拆（2026-10-16） ----------
 *
 * 主人把画布那条聊天侧栏整条拆了。画布要 AI 干活走它自己的工具条（顶部「AI 生成」、
 * 底部「图片 / 视频生成」），而让 agent 操作画布走主界面那条路（agent 手上就有 canvas_add_node）。
 * 所以这一格的断言（把手热区 / 开合 10 次 / Esc / 头上收起）连同那两个 testid 一起删 ——
 * 没有侧栏就没有可关的入口。
 *
 * ⚠️ 留一条：画布本身仍然要打得开。
 */
if (!(await openCanvas(page))) bad.push("画布打不开");


/* ---------- Esc 的边界：在输入框里打字时不许收面板 ---------- */

if (await openSummary(page)) {
  const input = page.locator('[data-testid="wb-summary"] input, [data-testid="wb-summary"] textarea').first();
  if ((await input.count()) > 0) {
    await input.click();
    await page.keyboard.press("Escape");
    await sleep(300);
    if ((await summaryState()).collapsed) {
      bad.push("焦点在输入框里时 Esc 把面板收掉了 —— 正在写的草稿会丢");
    } else {
      note("Esc 边界：焦点在输入框里时不收面板 ✓");
    }
  } else {
    note("（摘要面板里没有输入框，Esc 那条边界改由源码守卫覆盖）");
  }
  await page.keyboard.press("Escape");
  await sleep(300);
}

console.log("");
if (bad.length) {
  console.error("✗ " + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 右侧面板（摘要）：能开能关、收起入口带字、Esc 可关、往返 10 次一致 —— 画布那条侧栏已拆，见上面的说明");
}

await browser.close();
await killLeftovers();
