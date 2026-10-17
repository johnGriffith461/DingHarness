/**
 * **可自定义的全局快捷键**（L06 个性化）。
 *
 * ## 为什么单独一份、还放在 `shared/`
 *
 * 键位有两个消费者：**渲染层**（按下时判定）与**主进程**（落盘时收窄）。
 * 两边各写一遍 "Ctrl+Shift+T 算不算这个动作" 必然漂 —— 漂了的表现是
 * "界面显示 Ctrl K、按下却开了别的东西"，而这只有用户按了才知道。
 * 所以判定、格式化、校验、收窄全在这一份里，两边都 import 它。
 *
 * ## 存的是什么、不存什么
 *
 * 存**规范化字符串**（`Mod+K`），不存 JSON 对象：
 *   · `Mod` = Windows/Linux 的 Ctrl、macOS 的 Cmd（与 VS Code 同一套写法）；
 *   · 显示时再按平台换成 `Ctrl` / `Cmd`（见 `formatChord`）。
 * 存对象的话，"同一个组合"会有无数种键序写法，比较时要先规范化 ——
 * 不如写进去那一刻就规范化。
 *
 * ## 三条硬规矩（不满足就不给绑）
 *
 * 1. **必须带 `Mod`**。裸字母键会把输入吃掉 —— 用户打字时突然跳页；
 * 2. **不许占用系统/宿主键**（关闭窗口、退出、刷新、DevTools 等）——
 *    抢了这些键，用户没法用键盘关窗口；
 * 3. **不许重复**。两个动作绑同一个组合，后一个永远收不到。
 *
 * `""` 是合法值，表示"这个动作不绑快捷键"（用户可以解绑，功能仍可从界面点到）。
 */

/** 可以绑定的动作。 */
export type KeyAction = "palette" | "newChat" | "scheduled";

/** 动作清单（顺序即界面顺序）。 */
export const KEY_ACTIONS: readonly KeyAction[] = ["palette", "newChat", "scheduled"];

/** 动作的显示名（设置页与冲突提示共用）。 */
export const KEY_ACTION_LABELS: Record<KeyAction, string> = {
  palette: "命令面板",
  newChat: "新工作任务",
  scheduled: "定时任务",
};

/** 一份键位表。`""` = 未绑定。 */
export type Keymap = Record<KeyAction, string>;

/** 默认键位（与 L06 之前的既有键位一致 —— 升级不改变任何人的手感）。 */
export const DEFAULT_KEYMAP: Keymap = {
  palette: "Mod+K",
  newChat: "Mod+N",
  scheduled: "Mod+Shift+T",
};

/**
 * 宿主/系统占用的组合（小写规范化后比较）。
 *
 * 这些不是"我们觉得不好"，是**真的会被宿主先吃掉或造成不可逆动作**：
 * 关窗口、退出、刷新、DevTools、打印、全屏。
 */
const RESERVED: ReadonlySet<string> = new Set([
  "mod+q",
  "mod+w",
  "mod+r",
  "mod+l",
  "mod+shift+i",
  "mod+shift+j",
  "mod+shift+c",
  "mod+alt+i",
  "mod+p",
  "mod+shift+p",
  "f5",
  "f11",
  "f12",
]);

/** 一个解析好的组合。 */
export type ParsedChord = {
  mod: boolean;
  /** 显式 Ctrl（不带 Mod 语义时用；与 mod 互斥）。 */
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** 规范化后的主键（小写；`f1`…`f12` 或单个可见字符）。 */
  key: string;
};

/** 主键只认：单个字母/数字，或 F1–F12。 */
function normalizeMainKey(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  if (/^[a-z0-9]$/.test(key)) return key;
  if (/^f([1-9]|1[0-2])$/.test(key)) return key;
  return null;
}

/**
 * 解析规范化字符串。
 *
 * @param chord 例如 `Mod+K` / `Mod+Shift+T` / `Ctrl+Alt+1`
 * @returns 解析结果；不合法返回 null
 */
export function parseChord(chord: string): ParsedChord | null {
  const parts = String(chord ?? "")
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;

  const out: ParsedChord = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: "" };
  let main: string | null = null;
  for (const part of parts) {
    if (part === "mod") out.mod = true;
    else if (part === "ctrl" || part === "control") out.ctrl = true;
    else if (part === "cmd" || part === "meta" || part === "super") out.meta = true;
    else if (part === "alt" || part === "option") out.alt = true;
    else if (part === "shift") out.shift = true;
    else {
      /* 主键只能有一个；`Mod+K+J` 这种是写错了，不是"两个键位" */
      if (main !== null) return null;
      main = normalizeMainKey(part);
      if (!main) return null;
    }
  }
  if (!main) return null;
  out.key = main;
  return out;
}

/**
 * 把一个组合规范化成存储用的字符串（键序固定：Mod → Ctrl → Alt → Shift → 主键）。
 *
 * @param chord 用户写法（大小写、键序随意）
 * @returns 规范化字符串；不合法返回 null
 */
export function normalizeChord(chord: string): string | null {
  const parsed = parseChord(chord);
  if (!parsed) return null;
  const parts: string[] = [];
  if (parsed.mod) parts.push("Mod");
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.meta) parts.push("Meta");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(parsed.key.toUpperCase());
  return parts.join("+");
}

/** 校验失败的原因（**能直接给用户看**）。 */
export type ChordProblem = { ok: false; reason: string };

/**
 * 校验一个组合能不能绑。
 *
 * @param chord 待校验的字符串
 * @param others 其它动作现在占用的组合（`动作 → 组合`）
 * @param self 这次要绑的动作（避免"与自己重复"）
 * @returns `{ok:true}` 或一句给用户看的原因
 */
export function validateChord(
  chord: string,
  others: Partial<Record<KeyAction, string>> = {},
  self?: KeyAction,
): { ok: true; chord: string } | ChordProblem {
  const normalized = normalizeChord(chord);
  if (!normalized) return { ok: false, reason: "这个组合不合法：主键要是一个字母/数字或 F1–F12（例如 Ctrl+K）" };

  const parsed = parseChord(normalized)!;
  const modifierCount = [parsed.mod || parsed.ctrl || parsed.meta, parsed.alt, parsed.shift].filter(Boolean).length;
  if (!modifierCount) {
    return { ok: false, reason: "至少要带 Ctrl/Cmd —— 裸字母键会在你打字时把输入吃掉" };
  }
  if (!(parsed.mod || parsed.ctrl || parsed.meta)) {
    return { ok: false, reason: "要有 Ctrl 或 Cmd（Alt/Shift 单用不算：那是输入法与国际键盘的地盘）" };
  }
  if (parsed.mod && (parsed.ctrl || parsed.meta)) {
    return { ok: false, reason: "「Mod」已经代表 Ctrl/Cmd 了，不要再叠加一个" };
  }

  /* 保留键：用比较用的形态（把 Mod/Ctrl/Meta 统一成 mod，mac 上 Ctrl 与 Cmd 都占） */
  const compareKey =
    `${parsed.mod || parsed.ctrl || parsed.meta ? "mod+" : ""}` +
    `${parsed.alt ? "alt+" : ""}${parsed.shift ? "shift+" : ""}${parsed.key}`;
  if (RESERVED.has(compareKey)) {
    return { ok: false, reason: `${formatChord(normalized, false)} 是宿主占用的（关闭窗口/刷新/DevTools 之类），换一个` };
  }

  for (const [action, taken] of Object.entries(others)) {
    if (!taken || action === self) continue;
    if ((normalizeChord(taken) ?? taken) === normalized) {
      return { ok: false, reason: `这个组合已经给了「${KEY_ACTION_LABELS[action as KeyAction]}」，换一个` };
    }
  }
  return { ok: true, chord: normalized };
}

/** 平台显示名：`Mod` → `Ctrl`（Windows/Linux）或 `Cmd`（macOS）。 */
export function formatChord(chord: string, isMac: boolean): string {
  const normalized = normalizeChord(chord);
  if (!normalized) return chord;
  return normalized
    .split("+")
    .map((part) => {
      if (part === "Mod") return isMac ? "Cmd" : "Ctrl";
      if (part === "Ctrl") return "Ctrl";
      if (part === "Meta") return isMac ? "Cmd" : "Win";
      return part;
    })
    .join(" ");
}

/** 现在是不是 macOS（渲染层用；纯函数不自己读全局）。 */
export function isMacPlatform(platform: string | undefined): boolean {
  return /mac/i.test(platform ?? "");
}

/**
 * 键盘事件 → 组合字符串（给"按一下录制"用）。
 *
 * @param e 事件里那几个字段（测试不必造完整 KeyboardEvent）
 * @returns 规范化组合；只按了修饰键或主键不认识时返回 null
 */
export function chordFromEvent(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  /* 只按修饰键的那几次 keydown 不算 —— 录制时要等主键 */
  if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return null;
  const main = normalizeMainKey(e.key);
  if (!main) return null;
  const parts: string[] = [];
  /* Mod 只表示"键盘上的主修饰键"：Windows 上 ctrl、mac 上 meta。
     用户按了非主修饰键那边的（mac 的 Ctrl）就保留成 Ctrl，不悄悄改语义。 */
  const isMac = /Mac/i.test(readNavigatorPlatform());
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  else if (e.ctrlKey) parts.push("Ctrl");
  else if (e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(main.toUpperCase());
  return parts.join("+");
}

/** 读平台（防御式：单测环境没有 navigator）。 */
function readNavigatorPlatform(): string {
  try {
    return typeof navigator === "undefined" ? "" : (navigator.platform ?? "");
  } catch {
    return "";
  }
}

/**
 * 键盘事件命中哪个动作。
 *
 * @param e 事件字段
 * @param keymap 当前键位表
 * @returns 命中的动作；没有返回 null
 */
export function matchKeyAction(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  keymap: Keymap,
): KeyAction | null {
  for (const action of KEY_ACTIONS) {
    const chord = keymap[action];
    if (!chord) continue;
    const parsed = parseChord(chord);
    if (!parsed) continue;
    if (normalizeMainKey(e.key) !== parsed.key) continue;
    if (parsed.shift !== e.shiftKey) continue;
    if (parsed.alt !== e.altKey) continue;
    /* Mod = 平台主修饰键：ctrl 或 meta 任一命中即可（Electron 两种都可能来） */
    const wantsPrimary = parsed.mod || parsed.ctrl || parsed.meta;
    const hasPrimary = e.ctrlKey || e.metaKey;
    if (wantsPrimary !== hasPrimary) continue;
    return action;
  }
  return null;
}

/**
 * 收窄磁盘上的键位表。
 *
 * 坏值逐项回落默认；冲突时**后者让位**（先到先得，与权限规则的 findLast 无关 ——
 * 这里没有"更具体"的概念，只有先声明的人拿到那个组合）。实在让不开就解绑，
 * 而不是让两个动作抢同一个键。
 *
 * @param raw 磁盘上的值（不可信）
 * @returns 干净的键位表
 */
export function normalizeKeymap(raw: unknown): Keymap {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: Keymap = { palette: "", newChat: "", scheduled: "" };
  const used = new Set<string>();
  for (const action of KEY_ACTIONS) {
    const value = src[action];
    /*
     * 三种输入分开处理：
     * · 字符串且非空 → 按它（不合法再回落默认）；
     * · **空串** → 用户显式解绑，尊重它；
     * · 缺失/非字符串（旧版 settings.json 没有 keymap）→ 回落默认（升级不该丢键位）。
     */
    let candidate: string | null;
    if (typeof value === "string" && value.trim() === "") candidate = "";
    else if (typeof value === "string") candidate = normalizeChord(value);
    else candidate = DEFAULT_KEYMAP[action];

    if (candidate === "") {
      out[action] = "";
      continue;
    }
    if (!candidate || used.has(candidate)) {
      /* 坏值或冲突 → 回落默认；默认也被占了就解绑（不让两个动作抢同一个键） */
      const fallback = DEFAULT_KEYMAP[action];
      candidate = used.has(fallback) ? "" : fallback;
    }
    out[action] = candidate;
    if (candidate) used.add(candidate);
  }
  return out;
}
