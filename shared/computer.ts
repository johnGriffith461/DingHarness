/**
 * Computer Use 的动作与策略（V6-2n）。
 *
 * ## 三条硬边界（与实现一一对应）
 *
 * 1. **默认关**：`computer-use.json` 里 `enabled` 不是 `true` 就一律拒绝；
 * 2. **审批**：每一次动作都要求显式批准（界面弹确认；agent 那条走工具闸门）；
 * 3. **留痕**：每个动作（包括被拒的）都进 `computer-use.jsonl`；
 *    ⚠️ **不记录输入的文字本身**（可能是密码）—— 只记字符数与动作类型。
 *
 * ## 纯函数放这里
 *
 * 坐标校验、按键白名单、PowerShell 脚本构造都在 shared：不 import electron，
 * 所以能被单测一条条钉住。真正执行在 `electron/ipc/computer.ts`（Windows）。
 */

/** 允许的按键（白名单：不许任意字符串进 SendKeys）。 */
export const COMPUTER_KEYS = [
  "enter",
  "tab",
  "escape",
  "space",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "ctrl+a",
  "ctrl+c",
  "ctrl+v",
  "ctrl+x",
  "ctrl+z",
  "ctrl+s",
  "alt+tab",
] as const;

export type ComputerKey = (typeof COMPUTER_KEYS)[number];

/** 一次电脑操作。 */
export type ComputerAction =
  | { kind: "screenshot" }
  | { kind: "click"; x: number; y: number; button?: "left" | "right" }
  | { kind: "type"; text: string }
  | { kind: "key"; key: ComputerKey };

/** 屏幕边界（由宿主从 Electron `screen` 取）。 */
export type ScreenBounds = { width: number; height: number };

/** 一段文字最多一次输入多少字符（防止把整篇文档"敲"进去）。 */
export const COMPUTER_TYPE_MAX = 4000;

/**
 * 校验一个动作。
 *
 * @param action 动作（不可信）
 * @param bounds 屏幕尺寸（坐标必须落在屏幕内）
 * @returns 错误说明；合法返回 null
 */
export function validateComputerAction(action: unknown, bounds: ScreenBounds): string | null {
  if (!action || typeof action !== "object") return "动作必须是对象";
  const a = action as Record<string, unknown>;
  const kind = String(a.kind ?? "");
  if (kind === "screenshot") return null;
  if (kind === "click") {
    const x = Number(a.x);
    const y = Number(a.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return "坐标必须是整数";
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) {
      return `坐标超出屏幕：(${x}, ${y})，屏幕 ${bounds.width}×${bounds.height}`;
    }
    const button = a.button === undefined ? "left" : String(a.button);
    if (button !== "left" && button !== "right") return "button 只能是 left / right";
    return null;
  }
  if (kind === "type") {
    const text = typeof a.text === "string" ? a.text : "";
    if (!text) return "要输入的文字是空的";
    if (text.length > COMPUTER_TYPE_MAX) return `一次最多输入 ${COMPUTER_TYPE_MAX} 个字符（当前 ${text.length}）`;
    return null;
  }
  if (kind === "key") {
    const key = String(a.key ?? "");
    if (!(COMPUTER_KEYS as readonly string[]).includes(key)) {
      return `不支持的按键：${key}（可用：${COMPUTER_KEYS.join(" / ")}）`;
    }
    return null;
  }
  return `不认识的动作：${kind || "(空)"}`;
}

/** PowerShell 单引号字符串转义（单引号本身用两个单引号）。 */
export function psQuote(text: string): string {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/** 点击脚本（Windows user32）。 */
export function buildClickScript(action: Extract<ComputerAction, { kind: "click" }>): string {
  const down = action.button === "right" ? "0x0008" : "0x0002";
  const up = action.button === "right" ? "0x0010" : "0x0004";
  return [
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class DHMouse{[DllImport(\"user32.dll\")]public static extern bool SetCursorPos(int X,int Y);[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);}'",
    `[DHMouse]::SetCursorPos(${action.x}, ${action.y}) | Out-Null`,
    `[DHMouse]::mouse_event(${down},0,0,0,[UIntPtr]::Zero)`,
    `[DHMouse]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`,
  ].join("\n");
}

/** 按键脚本（SendKeys 白名单映射）。 */
export function buildKeyScript(key: ComputerKey): string {
  const map: Record<ComputerKey, string> = {
    enter: "{ENTER}",
    tab: "{TAB}",
    escape: "{ESC}",
    space: " ",
    backspace: "{BACKSPACE}",
    delete: "{DELETE}",
    up: "{UP}",
    down: "{DOWN}",
    left: "{LEFT}",
    right: "{RIGHT}",
    home: "{HOME}",
    end: "{END}",
    pageup: "{PGUP}",
    pagedown: "{PGDN}",
    "ctrl+a": "^a",
    "ctrl+c": "^c",
    "ctrl+v": "^v",
    "ctrl+x": "^x",
    "ctrl+z": "^z",
    "ctrl+s": "^s",
    "alt+tab": "%{TAB}",
  };
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(map[key])})`,
  ].join("\n");
}

/**
 * 输入文字脚本：走剪贴板粘贴（能处理中文与换行），粘完还原剪贴板。
 *
 * ⚠️ 这里会**短暂**改写用户的剪贴板 —— 这是 Windows 上最稳的 Unicode 输入方式；
 * 读不到旧值时清空（不把用户原有的内容留在剪贴板里当"副作用"）。
 */
export function buildTypeScript(text: string): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$old = Get-Clipboard -Raw -ErrorAction SilentlyContinue",
    `Set-Clipboard -Value ${psQuote(text)}`,
    "Start-Sleep -Milliseconds 80",
    "[System.Windows.Forms.SendKeys]::SendWait('^v')",
    "Start-Sleep -Milliseconds 150",
    "if ($null -ne $old) { Set-Clipboard -Value $old } else { Set-Clipboard -Value '' }",
  ].join("\n");
}

/** 审计条目（**不含输入的文字本身**）。 */
export type ComputerAuditEntry = {
  at: number;
  kind: ComputerAction["kind"];
  ok: boolean;
  /** 人话结果；类型输入只写字符数。 */
  detail: string;
};

/** 从动作生成审计条目（纯函数，测试能钉住"不记文字"这条）。 */
export function auditOf(action: ComputerAction, ok: boolean, detail: string, now = Date.now()): ComputerAuditEntry {
  if (action.kind === "type") {
    return { at: now, kind: "type", ok, detail: `${detail}（${action.text.length} 个字符，内容不记录）` };
  }
  return { at: now, kind: action.kind, ok, detail };
}
