/**
 * **组合键解析**（B-03，2026-10-22）。
 *
 * 模型给的是 `"Control+A"`、`"Shift+Tab"`、`"Enter"` 这种写法；CDP 要的是
 * `{ key, code, windowsVirtualKeyCode, modifiers }`。这张映射表放一处、可单测，
 * 免得在浏览器与 computer use 两边各解析一遍（迟早有一边不支持某个键）。
 */

/** CDP 的修饰位（`Input.dispatchKeyEvent` 的 `modifiers`）。 */
export const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export type ParsedCombo =
  | {
      ok: true;
      key: string;
      code: string;
      keyCode: number;
      modifiers: number;
    }
  | { ok: false; error: string };

/** 单键表：key → [code, virtualKeyCode]。只收常用键，认不出的如实拒（不猜）。 */
const KEYS: Record<string, [string, number]> = {
  enter: ["Enter", 13],
  return: ["Enter", 13],
  tab: ["Tab", 9],
  escape: ["Escape", 27],
  esc: ["Escape", 27],
  space: ["Space", 32],
  backspace: ["Backspace", 8],
  delete: ["Delete", 46],
  arrowup: ["ArrowUp", 38],
  arrowdown: ["ArrowDown", 40],
  arrowleft: ["ArrowLeft", 37],
  arrowright: ["ArrowRight", 39],
  home: ["Home", 36],
  end: ["End", 35],
  pageup: ["PageUp", 33],
  pagedown: ["PageDown", 34],
  // 字母与数字在下面按字符生成
};

/**
 * 解析 `"Control+A"` / `"Enter"`。
 *
 * 规则：`+` 分段，前几段是修饰键（Control/Ctrl、Shift、Alt、Meta/Cmd），最后一段是主键；
 * 主键认不出就报错（**不猜**）。
 */
export function parseKeyCombo(raw: string): ParsedCombo {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "key 不能为空" };
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, error: `认不出这个键：${raw}` };
  const main = parts[parts.length - 1] ?? "";
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  let modifiers = 0;
  for (const m of mods) {
    if (m === "control" || m === "ctrl") modifiers |= MODIFIER_BITS.ctrl;
    else if (m === "shift") modifiers |= MODIFIER_BITS.shift;
    else if (m === "alt" || m === "option") modifiers |= MODIFIER_BITS.alt;
    else if (m === "meta" || m === "cmd" || m === "command" || m === "win") modifiers |= MODIFIER_BITS.meta;
    else return { ok: false, error: `不认识的修饰键：${m}（支持 Control / Shift / Alt / Meta）` };
  }
  const lower = main.toLowerCase();
  const known = KEYS[lower];
  if (known) return { ok: true, key: lower === "return" ? "Enter" : keyDisplay(main), code: known[0], keyCode: known[1], modifiers };
  /* 单个字母或数字：给 A-Z / 0-9 的标准 code 与键码 */
  if (/^[a-z]$/i.test(main)) {
    const upper = main.toUpperCase();
    return { ok: true, key: modifiers & MODIFIER_BITS.shift ? upper : main.toLowerCase(), code: `Key${upper}`, keyCode: upper.charCodeAt(0), modifiers };
  }
  if (/^[0-9]$/.test(main)) {
    return { ok: true, key: main, code: `Digit${main}`, keyCode: main.charCodeAt(0), modifiers };
  }
  return { ok: false, error: `认不出这个键：${main}（支持 Enter/Tab/Escape/方向键/字母数字，或 Control+A 这种组合）` };
}

/** 显示用：`Enter` 保持原样，字母转大写更好读。 */
function keyDisplay(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === "enter" || lower === "return") return "Enter";
  if (lower === "tab") return "Tab";
  if (lower === "escape" || lower === "esc") return "Escape";
  if (lower === "space") return " ";
  if (lower.startsWith("arrow")) return `Arrow${lower.slice(5, 6).toUpperCase()}${lower.slice(6)}`;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
