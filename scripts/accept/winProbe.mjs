// 窗口的系统侧探针（最小化 / 最大化 / 拖动 / 矩形 / 置顶）。
//
// 为什么这些必须是 PowerShell 而不是 page.evaluate：
//   · **原生标题栏那一条不在 DOM 里** —— 它是窗口的几何，不是页面的几何；
//   · **拖动要真实鼠标输入**（SendInput）：app-region 的拖拽由**浏览器进程**处理，
//     Playwright 的合成事件驱动不了它（实测：好的拖动区被判成"拖不动"，假阴性）；
//   · 最小化之后页面自己点不到按钮了，只能从系统侧复位。
//
// `titleBarOverlay` 删掉之后（M0 工单 1）这几件事仍然是窗口级的，
// 所以这套助手在 `accept-windowctl` 与 `accept-dpi-matrix` 之间共用。
import { spawnSync } from "node:child_process";

/** 本应用窗口的标题（`BrowserWindow` 没设 title，用 productName / package name）。 */
const TITLE = "Ding Harness";

function ps(script) {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
}

/** 定位窗口的那几句（每段脚本自己拼在前面）。 */
const FIND = `$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*${TITLE}*" } | Select-Object -First 1;
if (-not $p) { Write-Output "NO_WINDOW"; exit 0 }
$h = $p.MainWindowHandle;`;

const WINAPI = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinProbe {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@;`;

/**
 * @typedef {{ l: number, t: number, r: number, b: number, w: number, h: number, iconic: boolean, zoomed: boolean }} WinRect
 */

/** 读窗口矩形与状态；窗口找不到时返回 null（**不要**编一个矩形出来）。 */
export function winRect() {
  const out = ps(`${WINAPI}
${FIND}
$r = New-Object WinProbe+RECT
[WinProbe]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Output ($r.L.ToString() + "," + $r.T.ToString() + "," + $r.R.ToString() + "," + $r.B.ToString() + "," + [WinProbe]::IsIconic($h).ToString() + "," + [WinProbe]::IsZoomed($h).ToString())`);
  if (!out || out === "NO_WINDOW") return null;
  const [l, t, r, b, iconic, zoomed] = out.split(",");
  return { l: +l, t: +t, r: +r, b: +b, w: +r - +l, h: +b - +t, iconic: iconic === "True", zoomed: zoomed === "True" };
}

/** 从系统侧复原窗口（最小化之后页面自己点不到按钮）。 */
export function restoreWindow() {
  ps(`${WINAPI}
${FIND}
[WinProbe]::ShowWindow($h, 9) | Out-Null`);
}

/**
 * 用**真实鼠标输入**拖窗口（SWP 置顶 → 按下 → 分步移动 → 松开 → 撤置顶）。
 *
 * @param offsetX 起点相对窗口左缘
 * @param offsetY 起点相对窗口上缘
 * @param steps 分几步（必须分步：一步到位不算拖）
 * @param step 每步位移（右、下各这么多）
 * @returns 起点的屏幕坐标描述（写进报告用）
 */
export function realDrag(offsetX, offsetY, steps, step) {
  return ps(`${WINAPI}
${FIND}
# 真实点击会落到**最上层**的窗口上，不置顶就可能点在别的窗口上
[WinProbe]::SetWindowPos($h, [IntPtr]::new(-1), 0, 0, 0, 0, 0x43) | Out-Null
Start-Sleep -Milliseconds 250
$r = New-Object WinProbe+RECT
[WinProbe]::GetWindowRect($h, [ref]$r) | Out-Null
$sx = $r.L + ${offsetX}; $sy = $r.T + ${offsetY}
[WinProbe]::SetCursorPos($sx, $sy) | Out-Null; Start-Sleep -Milliseconds 200
[WinProbe]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 120
for ($i = 1; $i -le ${steps}; $i++) {
  [WinProbe]::SetCursorPos($sx + $i * ${step}, $sy + $i * ${step}) | Out-Null
  Start-Sleep -Milliseconds 40
}
[WinProbe]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 250
[WinProbe]::SetWindowPos($h, [IntPtr]::new(-2), 0, 0, 0, 0, 0x43) | Out-Null
Write-Output ("from " + $sx + "," + $sy)`);
}
