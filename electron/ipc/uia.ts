import { execFileSync } from "node:child_process";

import type { UiaAction, UiaSnapshot } from "../../shared/uia";

/**
 * **Windows UI Automation 桥**（G05，2026-10-18）。
 *
 * ## 为什么用 PowerShell 而不是原生模块
 *
 * UIA 是 COM API。两条路：
 * - **原生模块**（node-gyp / N-API）：要编译、要跟 Electron 的 ABI 对齐、
 *   打包时要带 .node —— 维护成本高，而这一步只是"枚举 + 调模式"；
 * - **PowerShell + UIAutomationClient**：系统自带、零依赖、调用是一次子进程。
 *   代价是每次调用几十毫秒（可接受：一个动作本来就是秒级）。
 *
 * 这里选后者，并**如实记下边界**：它需要 PowerShell（Windows 自带）、
 * 每次调用起一个进程；非 Windows 一律返回明确错误（不假装支持）。
 *
 * ## 后台操作
 *
 * UIA 的 `InvokePattern` / `ValuePattern` 直接作用于控件，**不需要**窗口在前台。
 * 只有 `focus` 会改变焦点 —— 那是它的语义本身。
 */

/** 枚举脚本：先把顶层窗口列出来（模型据此选窗口）。 */
const LIST_WINDOWS = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = [System.Windows.Automation.Condition]::TrueCondition
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$out = @()
foreach ($w in $wins) {
  $procId = 0
  try { $procId = $w.Current.ProcessId } catch { continue }
  if ($w.Current.Name -eq "") { continue }
  $proc = ""
  try { $proc = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  $out += [pscustomobject]@{ name = $w.Current.Name; process = $proc }
}
$out | ConvertTo-Json -Compress
`;

/**
 * 快照脚本：按**窗口标题**（或前台窗口）枚举控件树。
 *
 * 参数通过环境变量传（避免把用户给的标题拼进 PowerShell 源码 —— 那是注入面）。
 */
const SNAPSHOT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
$want = $env:DSH_UIA_WINDOW
$max = [int]$env:DSH_UIA_MAX
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = [System.Windows.Automation.Condition]::TrueCondition
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$target = $null
if ($want) {
  foreach ($w in $wins) { if ($w.Current.Name -eq $want) { $target = $w; break } }
  if (-not $target) {
    foreach ($w in $wins) { if ($w.Current.Name -like "*$want*") { $target = $w; break } }
  }
} else {
  try { $target = [System.Windows.Automation.AutomationElement]::FocusedElement } catch {}
  if ($target) {
    $walker0 = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    while ($target -and $target.Current.ControlType.ProgrammaticName -ne "ControlType.Window") {
      $target = $walker0.GetParent($target)
    }
  }
}
if (-not $target) { Write-Output '{"error":"没有找到目标窗口"}'; exit 0 }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$elements = @()
$truncated = $false
function Walk($el, $depth) {
  if ($script:elements.Count -ge $script:max) { $script:truncated = $true; return }
  if ($depth -gt 12) { return }
  try { $cur = $el.Current } catch { return }
  $pats = @()
  $obj = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$obj)) { $pats += "invoke" } } catch {}
  $obj = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$obj)) { $pats += "setValue" } } catch {}
  $obj = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$obj)) { $pats += "toggle" } } catch {}
  $obj = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$obj)) { $pats += "expand" } } catch {}
  $r = $cur.BoundingRectangle
  $value = $null
  if ($pats -contains "setValue") {
    try {
      $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $value = $vp.Current.Value
      if ($value -and $value.Length -gt 40) { $value = $value.Substring(0, 40) + "…" }
    } catch {}
  }
  $script:elements += [pscustomobject]@{
    controlType = ($cur.ControlType.ProgrammaticName -replace '^ControlType\.','')
    name = [string]$cur.Name
    automationId = [string]$cur.AutomationId
    bounds = @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
    patterns = $pats
    value = $value
  }
  $child = $walker.GetFirstChild($el)
  while ($child) {
    Walk $child ($depth + 1)
    if ($script:elements.Count -ge $script:max) { break }
    $child = $walker.GetNextSibling($child)
  }
}
$script:elements = $elements
$script:max = $max
$windowName = $target.Current.Name
$procId = $target.Current.ProcessId
Walk $target 0
$procName = ""
try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
[pscustomobject]@{
  window = $windowName
  process = $procName
  elements = $script:elements
  truncated = $script:truncated
} | ConvertTo-Json -Depth 6 -Compress
`;

/**
 * 动作脚本：先按**快照时记下的签名**（automationId / 名字 / 控件类型）找元素，
 * 找不到再退回索引。
 *
 * ⚠️ 为什么不能只按索引：UIA 的树在活着的应用里会变（状态栏文字更新、标签页标题变化），
 * 索引会整体移位 —— 实测过：快照时 `#27` 是「设置」按钮，执行时 `#27` 变成了另一个标签页。
 * 签名匹配对"兄弟节点数量变化"不敏感。
 */
const ACT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
$want = $env:DSH_UIA_WINDOW
$index = [int]$env:DSH_UIA_INDEX
$action = $env:DSH_UIA_ACTION
$text = $env:DSH_UIA_TEXT
$wantAid = $env:DSH_UIA_AID
$wantName = $env:DSH_UIA_NAME
$wantType = $env:DSH_UIA_TYPE
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = [System.Windows.Automation.Condition]::TrueCondition
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$target = $null
if ($want) {
  foreach ($w in $wins) { if ($w.Current.Name -eq $want) { $target = $w; break } }
  if (-not $target) { foreach ($w in $wins) { if ($w.Current.Name -like "*$want*") { $target = $w; break } } }
} else {
  try { $target = [System.Windows.Automation.AutomationElement]::FocusedElement } catch {}
  if ($target) {
    $walker0 = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    while ($target -and $target.Current.ControlType.ProgrammaticName -ne "ControlType.Window") { $target = $walker0.GetParent($target) }
  }
}
if (-not $target) { Write-Output '{"ok":false,"error":"没有找到目标窗口"}'; exit 0 }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$script:all = @()
function Walk($el, $depth) {
  if ($depth -gt 12) { return }
  try { $null = $el.Current } catch { return }
  $script:all += $el
  $child = $walker.GetFirstChild($el)
  while ($child) { Walk $child ($depth + 1); $child = $walker.GetNextSibling($child) }
}
Walk $target 0
$match = $null
if ($wantAid) {
  foreach ($el in $script:all) { try { if ($el.Current.AutomationId -eq $wantAid) { $match = $el; break } } catch {} }
}
if (-not $match -and $wantName) {
  foreach ($el in $script:all) {
    try {
      $t = $el.Current.ControlType.ProgrammaticName
      if ($el.Current.Name -eq $wantName -and $t -like "*$wantType") { $match = $el; break }
    } catch {}
  }
}
if (-not $match -and $index -lt $script:all.Count) { $match = $script:all[$index] }
if (-not $match) { Write-Output '{"ok":false,"error":"找不到这个元素（窗口变了，重新取快照）"}'; exit 0 }
$el = $match
$detail = ""
try {
  switch ($action) {
    "invoke" {
      $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $p.Invoke(); $detail = "已 invoke"
    }
    "setValue" {
      $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $p.SetValue($text); $detail = "已写入 " + $text.Length + " 个字符"
    }
    "toggle" {
      $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
      $p.Toggle(); $detail = "已切换"
    }
    "expand" {
      $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      $p.Expand(); $detail = "已展开"
    }
    "focus" {
      $el.SetFocus(); $detail = "已聚焦"
    }
    default { throw "不认识的动作：$action" }
  }
  $name = $el.Current.Name
  [pscustomobject]@{ ok = $true; detail = $detail; name = $name } | ConvertTo-Json -Compress
} catch {
  $hit = ""
  try { $hit = $el.Current.Name } catch {}
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message; name = $hit } | ConvertTo-Json -Compress
}
`;

/** 一次 PowerShell 调用的超时（枚举稍长，动作快）。 */
const ENUM_TIMEOUT_MS = 20_000;
const ACT_TIMEOUT_MS = 10_000;

/**
 * 最近一次快照（按窗口）。
 *
 * 用途：动作只带 `#N` 索引，而索引会在活着的应用里移位（见 ACT 的说明）。
 * 所以动作执行时，从这里取出**快照那一刻**的元素签名（automationId / 名字 / 类型）
 * 一起交给 PowerShell —— 它先按签名找，找不到才退回索引。
 *
 * 只留最近 8 个窗口（不是无限缓存）：它是"刚才那张快照"的旁注，不是历史。
 */
const lastSnapshots = new Map<string, UiaSnapshot>();

/** 平台能力（如实）。 */
export function uiaSupported(): boolean {
  return process.platform === "win32";
}

/** 跑一段 PowerShell（UTF-8 输出、隐藏窗口、有超时）。 */
function runPowerShell(script: string, env: Record<string, string>, timeout: number): unknown {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      timeout,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...env },
    },
  );
  const text = out.toString("utf8").trim();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

/**
 * 列出可操作窗口。
 *
 * @returns 窗口标题与进程名
 */
export function listUiaWindows(): Array<{ name: string; process: string }> {
  if (!uiaSupported()) return [];
  try {
    const got = runPowerShell(LIST_WINDOWS, {}, ENUM_TIMEOUT_MS);
    if (!got) return [];
    return (Array.isArray(got) ? got : [got]) as Array<{ name: string; process: string }>;
  } catch {
    return [];
  }
}

/**
 * 取一个窗口的元素树。
 *
 * @param window 窗口标题（省略 = 前台窗口）
 * @param max 最多枚举多少元素
 */
export function snapshotUiaWindow(window: string | undefined, max = 200): { ok: true; value: UiaSnapshot } | { ok: false; error: string } {
  if (!uiaSupported()) return { ok: false, error: "元素定位目前只实现了 Windows（其它平台会给坐标版，它不抢焦点的版本还没做）" };
  try {
    const got = runPowerShell(SNAPSHOT, { DSH_UIA_WINDOW: window ?? "", DSH_UIA_MAX: String(max) }, ENUM_TIMEOUT_MS) as
      | { error?: string; window?: string; process?: string; elements?: unknown[]; truncated?: boolean }
      | null;
    if (!got) return { ok: false, error: "枚举没有返回结果（PowerShell 起不来？）" };
    if (got.error) return { ok: false, error: String(got.error) };
    const rawElements = Array.isArray(got.elements) ? got.elements : [];
    const elements = rawElements.map((item, index) => {
      const e = (item ?? {}) as Record<string, unknown>;
      const b = (e.bounds ?? {}) as Record<string, unknown>;
      return {
        index,
        controlType: String(e.controlType ?? ""),
        name: String(e.name ?? ""),
        automationId: String(e.automationId ?? ""),
        bounds: { x: Number(b.x) || 0, y: Number(b.y) || 0, w: Number(b.w) || 0, h: Number(b.h) || 0 },
        patterns: Array.isArray(e.patterns) ? (e.patterns as string[]) : [],
        ...(typeof e.value === "string" ? { value: e.value } : {}),
      };
    });
    const value: UiaSnapshot = {
      window: String(got.window ?? ""),
      process: String(got.process ?? ""),
      elements,
      truncated: got.truncated === true,
    };
    /* 记住这张快照（动作要用它的元素签名） */
    lastSnapshots.set(value.window, value);
    if (lastSnapshots.size > 8) {
      const oldest = lastSnapshots.keys().next().value;
      if (oldest !== undefined) lastSnapshots.delete(oldest);
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: `枚举失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
  }
}

/**
 * 对一个元素做一个动作。
 *
 * @param window 窗口标题（省略 = 前台）
 * @param index 元素索引（快照里的）
 * @param action 动作
 * @param text `setValue` 用的文字
 */
export function actOnUiaElement(
  window: string | undefined,
  index: number,
  action: UiaAction,
  text = "",
): { ok: true; detail: string; name: string } | { ok: false; error: string } {
  if (!uiaSupported()) return { ok: false, error: "元素定位目前只实现了 Windows" };
  /* 快照里那一格的签名（窗口标题优先用快照里的，与取树时同一个） */
  const snap = window ? lastSnapshots.get(window) : [...lastSnapshots.values()].at(-1);
  const el = snap?.elements.find((e) => e.index === index);
  try {
    const got = runPowerShell(
      ACT,
      {
        DSH_UIA_WINDOW: window ?? snap?.window ?? "",
        DSH_UIA_INDEX: String(index),
        DSH_UIA_ACTION: action,
        DSH_UIA_TEXT: text,
        DSH_UIA_AID: el?.automationId ?? "",
        DSH_UIA_NAME: el?.name ?? "",
        DSH_UIA_TYPE: el?.controlType ?? "",
      },
      ACT_TIMEOUT_MS,
    ) as { ok?: boolean; detail?: string; name?: string; error?: string } | null;
    if (!got) return { ok: false, error: "动作没有返回结果" };
    if (got.ok === true) return { ok: true, detail: String(got.detail ?? ""), name: String(got.name ?? "") };
    /* 失败时把"实际命中的是哪个元素"也带出来 —— 索引错位时这句是唯一的线索 */
    const hit = got.name ? `（命中的元素是「${got.name}」）` : "";
    return { ok: false, error: `${String(got.error ?? "动作失败（没有原因）")}${hit}` };
  } catch (error) {
    return { ok: false, error: `动作失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
  }
}
