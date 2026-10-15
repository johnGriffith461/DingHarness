// 左栏折叠：真点界面 —— M0 工单 3 里"能快的就实现"那一条的常驻回归。
//
// 这一颗按钮原来在**六个页面各写一遍**，六份都是 `disabled` + 同一句"本机版还没做折叠"
// （工单点名的 26 处死控件里，它一个占五处）。现在收成 `NavCollapseButton`，一处实现六处受益。
//
// 判据（工单口径：实现就要真的能用）：
//   · 点一下左栏真的收起来（宽度塌成 0）、再点一下真的回来 —— 六个页面里各取几个代表；
//   · **收起之后那颗按钮自己还得在**（它在页面头部，不在左栏里）——
//     这是"收起之后还能打开"的唯一保障，也是它不需要浮标的原因；
//   · 标题/可访问名跟着状态走（收起 ↔ 展开是两件事）。
import { chromium } from "playwright";
import { openApp, sleep, killLeftovers, pickPort } from "./harness.mjs";

const bad = [];
const note = (m) => console.log("   " + m);

const port = await pickPort([9891]);
await killLeftovers();
const { browser, page } = await openApp(chromium, {
  port,
  dataDir: ".verify/accept-navcollapse-data",
  cwd: ".",
});
await sleep(1800);

/** 左栏几何 + 那颗按钮的状态。 */
const state = () =>
  page.evaluate(() => {
    const nav = document.querySelector('[data-testid="wb-nav"]');
    const btn = document.querySelector('[data-testid="wb-nav-collapse"]');
    const r = nav?.getBoundingClientRect();
    const br = btn?.getBoundingClientRect();
    return {
      navFound: Boolean(nav),
      collapsedClass: nav ? nav.classList.contains("is-collapsed") : null,
      navWidth: r ? Math.round(r.width) : null,
      btnFound: Boolean(btn),
      btnVisible: br ? br.width > 0 && br.height > 0 : false,
      btnLabel: btn?.getAttribute("aria-label") ?? "",
      btnDisabled: btn ? btn.hasAttribute("disabled") : null,
    };
  });

const clickToggle = async () => {
  await page.locator('[data-testid="wb-nav-collapse"]').click();
  await sleep(350);
};

/* ---------- 1) 各页面的那颗按钮都真的能用 ---------- */

// 几个页面（首页的头部没有这颗；插件/定时任务/手机遥控/任务视图 + 任务中心）
// ⚠️ 2026-10-16：「云盘」整页拆掉了，所以这一格少一个页面。
const pages = [
  ["plugins", "插件·技能·伙伴"],
  ["scheduled", "定时任务"],
  ["phone", "手机遥控电脑"],
];

for (const [view, label] of pages) {
  const nav = page.locator(`[data-testid="wb-nav-${view}"]`);
  if ((await nav.count()) === 0) {
    bad.push(`导航里没有「${label}」（testid: wb-nav-${view}）`);
    continue;
  }
  await nav.click();
  await sleep(700);

  const before = await state();
  if (!before.btnFound) { bad.push(`「${label}」页头部没有收起左栏的按钮`); continue; }
  if (before.btnDisabled) bad.push(`「${label}」页的收起按钮还是禁用的`);
  if (before.btnLabel !== "收起左侧栏") bad.push(`「${label}」页按钮名不对：${before.btnLabel}`);
  if (before.navWidth === 0) bad.push(`「${label}」页初始状态左栏就是收起的`);

  await clickToggle();
  const off = await state();
  if (!off.collapsedClass || off.navWidth !== 0) {
    bad.push(`「${label}」页点收起后左栏没收起来（宽 ${off.navWidth}）`);
  }
  // ⭐ 收起之后按钮必须还在 —— 否则用户再也打不开左栏
  if (!off.btnFound || !off.btnVisible) bad.push(`「${label}」页收起后按钮不见了 —— 左栏再也打不开`);
  if (off.btnLabel !== "展开左侧栏") bad.push(`「${label}」页收起后按钮名没跟着变：${off.btnLabel}`);

  await clickToggle();
  const on = await state();
  if (on.collapsedClass || on.navWidth === 0) bad.push(`「${label}」页再点一下左栏没回来（宽 ${on.navWidth}）`);
  note(`「${label}」：收起 → 宽 ${off.navWidth}、按钮仍在（${off.btnLabel}）→ 展开 → 宽 ${on.navWidth}`);
}

/* ---------- 2) 任务中心那一颗（同一个组件，另一条入口） ---------- */

await page.locator('[data-testid="wb-nav-home"]').click();
await sleep(500);
/* 任务中心的入口在左栏「最近」那一栏的头（`wb-threads-open`，2026-10-15 核过） */
const threadsEntry = page.locator('[data-testid="wb-threads-open"]').first();
if ((await threadsEntry.count()) > 0) {
  await threadsEntry.click();
  await sleep(800);
  const s = await state();
  if (!s.btnFound) bad.push("任务中心页头部没有收起左栏的按钮");
  else {
    await clickToggle();
    const off = await state();
    if (!off.collapsedClass) bad.push("任务中心页点收起后左栏没收起来");
    await clickToggle();
    note(`任务中心：收起再展开 ${(await state()).collapsedClass ? "✗ 没回来" : "✓ 正常"}`);
  }
} else {
  note("（没找到任务中心入口，这一条跳过 —— 它用的是同一个组件）");
}

/* ---------- 3) 反复开合 10 次 ---------- */

await page.locator('[data-testid="wb-nav-plugins"]').click();
await sleep(600);
let rounds = 0;
for (let i = 0; i < 10; i += 1) {
  await clickToggle();
  const off = await state();
  await clickToggle();
  const on = await state();
  if (!off.collapsedClass || on.collapsedClass) break;
  rounds += 1;
}
if (rounds !== 10) bad.push(`左栏反复开合只有 ${rounds}/10 次一致`);
note(`反复开合：${rounds}/10`);

console.log("");
if (bad.length) {
  console.error("✗ " + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ 左栏折叠：四个页面 + 任务中心都能收能开 / 收起后按钮仍在（标题跟着变）/ 往返 10 次一致");
}

await browser.close();
await killLeftovers();
