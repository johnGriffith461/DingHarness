// DPI / 窗口行为矩阵 —— M0 工单 4 机制 3。
//
// 工单原话：「100% / 125% / 150% × 最大化 / 还原 × 单 / 多显示器，标题栏与按钮行为每格断言
// （工单 1 的验收即其首例）」。
//
// ## 为什么这条值得单独存在
//
// 窗口右上的那一套按钮原来是 `titleBarOverlay` 让 **Windows 原生画的**，
// 而它的几何在缩放变化时不受应用控制（`height: 36` 是 DIP，物理高度随缩放走）
// —— 这正是"某些机器上看着不对"的经典来源。现在按钮改由应用自绘（M0 工单 1），
// 缩放会不会又把它带歪，必须**每格实测**，不能靠"应该没事"。
//
// ## 如实记下的边界
//
// · **多显示器没覆盖**：这台机器只有一块 1920×1080 的屏（`SystemInformation.VirtualScreen`）。
//   脚本会把它读出来写进报告，而不是假装测过。要覆盖多屏得换机器或加虚拟显示器 —— 那是另一件事。
// · **缩放用 `--force-device-scale-factor` 驱动**，不要求改系统设置（也不该改用户的设置）。
//   它走的是 Chromium 的同一条缩放路径，标题栏与按钮的行为可以照常判定。
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { openApp, sleep, killLeftovers, pickPort } from "./harness.mjs";
import { winRect } from "./winProbe.mjs";

const bad = [];
const note = (m) => console.log("   " + m);

/** 屏幕尺寸（写进报告：说明这次到底覆盖了什么）。 */
function screenInfo() {
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms
$v = [System.Windows.Forms.SystemInformation]::VirtualScreen
$s = [System.Windows.Forms.Screen]::AllScreens
Write-Output ($v.Width.ToString() + "x" + $v.Height.ToString() + " screens=" + $s.Count)`,
    ],
    { encoding: "utf8" },
  );
  return (r.stdout ?? "").trim();
}

/** 一格里要判的东西：自绘按钮、拖动区、标题栏底下不得有可点元素、页面是否报告被最大化。 */
async function probeDom(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="wb-titlebar"]');
    const ctl = document.querySelector('[data-testid="wb-winctl"]');
    const btns = ctl ? [...ctl.querySelectorAll("button")] : [];
    const barRect = bar?.getBoundingClientRect();
    const bandBottom = barRect ? Math.round(barRect.bottom) : 0;
    const under = [];
    for (const el of document.querySelectorAll("button, a, input, select, textarea, [role=button], [tabindex]")) {
      if (el.closest('[data-testid="wb-titlebar"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.top < bandBottom && r.bottom > 0) {
        under.push(el.getAttribute("data-testid") || (el.textContent ?? "").trim().slice(0, 16));
      }
    }
    return {
      count: btns.length,
      labels: btns.map((b) => b.getAttribute("aria-label")),
      region: bar ? getComputedStyle(bar).getPropertyValue("-webkit-app-region").trim() : "",
      bandBottom,
      bandWidth: barRect ? Math.round(barRect.width) : 0,
      dpr: window.devicePixelRatio,
      vw: window.innerWidth,
      vh: window.innerHeight,
      under,
      maxBtnState: document.querySelector('[data-testid="wb-win-max"]')?.getAttribute("data-maximized") ?? null,
    };
  });
}

const screen = screenInfo();
console.log(`屏幕：${screen}`);
note(screen.includes("screens=1") ? "只有一块屏 —— 多显示器那一维**本次没覆盖**（如实记，不假装）" : "多屏，逐格只验主屏上的行为");

for (const scale of ["1", "1.25", "1.5"]) {
  const port = await pickPort([9921, 9931, 9941]);
  await killLeftovers();
  const { browser, page } = await openApp(chromium, {
    port,
    dataDir: `.verify/accept-dpi-data-${scale}`,
    cwd: ".",
    extraArgs: [`--force-device-scale-factor=${scale}`],
  });
  await sleep(1800);

  /* ---- 还原态 ---- */
  const restored = await probeDom(page);
  const rRect = winRect();
  if (restored.count !== 3) bad.push(`[${scale}×还原] 窗口按钮不是 3 个（${restored.count}）`);
  if (restored.region !== "drag") bad.push(`[${scale}×还原] 标题栏不是拖动区（${restored.region || "空"}）`);
  if (restored.under.length) {
    bad.push(`[${scale}×还原] 标题栏底下压着 ${restored.under.length} 个可点元素：${restored.under.join(" / ")}`);
  }
  if (restored.bandWidth !== restored.vw) {
    bad.push(`[${scale}×还原] 标题栏没铺满窗口宽（${restored.bandWidth} vs ${restored.vw}）`);
  }
  if (!rRect) bad.push(`[${scale}×还原] 从系统侧读不到窗口矩形`);
  if (restored.maxBtnState !== "false") {
    bad.push(`[${scale}×还原] 还原态下按钮却报最大化（data-maximized=${restored.maxBtnState}）`);
  }
  note(`[${scale}×还原] dpr=${restored.dpr} 视口=${restored.vw}×${restored.vh} 窗口=${rRect?.w}×${rRect?.h} 标题栏高=${restored.bandBottom} 按钮=${restored.labels.join("/")}`);

  /* ---- 最大化态（点应用自己那颗按钮） ---- */
  await page.locator('[data-testid="wb-win-max"]').click();
  await sleep(1000);
  const maxed = await probeDom(page);
  const mRect = winRect();
  if (maxed.maxBtnState !== "true") bad.push(`[${scale}×最大化] 按钮状态没跟着变（data-maximized=${maxed.maxBtnState}）`);
  if (!mRect?.zoomed) bad.push(`[${scale}×最大化] 系统侧说窗口没在最大化（IsZoomed=false）`);
  if (rRect && mRect && mRect.h <= rRect.h) {
    bad.push(`[${scale}×最大化] 最大化后没有变大（${rRect.h} → ${mRect.h}）`);
  }
  if (maxed.under.length) {
    bad.push(`[${scale}×最大化] 标题栏底下压着 ${maxed.under.length} 个可点元素：${maxed.under.join(" / ")}`);
  }
  if (maxed.count !== 3) bad.push(`[${scale}×最大化] 窗口按钮不是 3 个（${maxed.count}）`);
  note(`[${scale}×最大化] 窗口=${mRect?.w}×${mRect?.h} zoomed=${mRect?.zoomed} 按钮=${maxed.labels.join("/")}`);

  /* ---- 还原回去 ---- */
  await page.locator('[data-testid="wb-win-max"]').click();
  await sleep(900);
  const back = await probeDom(page);
  const bRect = winRect();
  if (back.maxBtnState !== "false") bad.push(`[${scale}×还原回来] 按钮状态没回来（${back.maxBtnState}）`);
  if (rRect && bRect && Math.abs(bRect.h - rRect.h) > 2) {
    bad.push(`[${scale}×还原回来] 尺寸没回到原样（${rRect.h} → ${bRect.h}）`);
  }
  note(`[${scale}×还原回来] 窗口=${bRect?.w}×${bRect?.h} 按钮 data-maximized=${back.maxBtnState}`);

  await browser.close();
  await killLeftovers();
}

console.log("");
if (bad.length) {
  console.error("✗ DPI 矩阵：" + bad.join("；"));
  process.exitCode = 1;
} else {
  console.log("✓ DPI 矩阵：100% / 125% / 150% × 还原·最大化·再还原 —— 每格都是自绘一套按钮、标题栏是拖动区、底下无被压元素、状态与系统侧一致（多显示器未覆盖，见脚本头）");
}
