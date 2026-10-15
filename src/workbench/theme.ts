/**
 * 深色主题的取值、持久化与生效。
 *
 * 口径来自本体（豆包工作）账号菜单里的「外观设置」子菜单 —— **三选一**：
 *   跟随系统（默认，带勾） / 浅色模式 / 深色模式
 *
 * 深色样式本身是 `.wb.is-dark` 那一段（**纯加成**，浅色主题不受影响）；
 * 这里只管"选哪一档、记不记得住、挂不挂上去"。
 *
 * 持久化沿用本机既有做法（`localStorage`，与 `dsh-canvas.chat-settings` 同期）——
 * 不为一个开关另开 `remote.json` 那类主进程通道。
 */

/** 存储键。 */
export const THEME_KEY = "dsh-canvas.theme";

/**
 * 外观设置的三个取值，与本体子菜单一一对应。
 *
 * `"system"` 是本体里的默认项（子菜单上带勾的那一项）。
 */
export type Theme = "system" | "light" | "dark";

/** 子菜单展示顺序，与本体截图一致。 */
export const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色模式" },
  { value: "dark", label: "深色模式" },
];

/** 系统当前是否偏好深色。 */
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * 读回上次选的外观设置。
 *
 * @returns 三档之一；读不到或值不合法时给 `"system"`（与本体默认一致）
 */
export function readTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* 读不到就按默认档走 */
  }
  return "system";
}

/**
 * 某一档在外观上实际落到深色还是浅色。
 *
 * 「跟随系统」不是一种颜色，而是一条**规则** —— 所以"选了什么"与
 * "现在是什么颜色"必须分开：前者是设置，后者是渲染依据。
 *
 * @param theme 用户选的档位
 * @param prefersDark 系统当前是否偏好深色
 * @returns 实际渲染成深色则为 true
 */
export function resolvesToDark(theme: Theme, prefersDark: boolean): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return prefersDark;
}

/**
 * 把主题挂到工作台根节点上。
 *
 * `.wb` 是工作台最外层（画布 `.wb-canvas` 在它里面，本来就是深色）——
 * 所以类名挂在 `.wb` 上，深色作用域自然覆盖到整个工作台。
 *
 * @param dark 是否渲染成深色
 */
/**
 * Ding Harness 提案 §05「主题切换：为什么不是渐变过去」（motion.css THREE-A）。
 *
 * 翻转主题会同时改掉几乎每个元素的 color / background / border / shadow ——
 * **所有** transition 一起触发，整页不是"干脆地换"而是"糊"一下。
 * 做法：改属性之前注入一条全局掐断过渡的样式，改完强制 reflow（让新主题
 * 在这一帧就落地），再把那条样式摘掉（下一帧过渡自然恢复）。
 *
 * ⚠️ 全部对 DOM 能力做**防御性判断**：`theme.test.ts` 用的是手搭的极简
 * `document` 替身（没有 `createElement`、没有 `body`）。而"切主题"这件事本身
 * 不该因为"这个环境没有注入 style 标签的能力"而整个失效 —— 兜底成"直接切"。
 *
 * @param fn 真正改属性的动作
 */
function withTransitionsSuppressed(fn: () => void): void {
  const canInject =
    typeof document !== "undefined" && typeof document.createElement === "function";
  const kill = canInject ? document.createElement("style") : null;
  if (kill) {
    kill.textContent = "*,*::before,*::after{transition:none !important;animation:none !important}";
    if (document.head) document.head.appendChild(kill);
  }
  try {
    fn();
    /* 强制 reflow：不读一次布局，浏览器会把"注入 + 摘掉"合成同一帧，等于没做 */
    if (typeof document !== "undefined" && document.body) void document.body.offsetWidth;
  } finally {
    kill?.remove();
  }
}

export function applyDark(dark: boolean): void {
  /*
   * 载体是 **`<html data-theme>`**，与本体一致（recovered-src 的 profile-theme.ts）。
   *
   * 为什么不挂在工作台根节点的类名上：本体的属性能被**任何组件**订阅到
   * （它那边用的是 MutationObserver 监听 documentElement 的 data-theme），
   * 而挂在子树上的类名只有那棵子树吃得到 —— 这正是之前反复撞的
   * "只打通了一处"（§43/§52/§87）的根因。
   */
  const root = document.documentElement;
  if (!root) return;

  /*
   * 放在这里而不是各个调用点，是因为 `applyDark` 是本仓改主题的**唯一收口**：
   * 三档外观设置、跟随系统的变化、启动时那一次，全都从这条路过去。
   */
  withTransitionsSuppressed(() => {
    root.setAttribute("data-theme", dark ? "dark" : "light");
  });

  /*
   * ⚠️ 这里**曾经**还要走一条 IPC 去改标题栏覆盖层的配色（`shell.setTitlebar`）——
   * 因为那套原生按钮是**主进程**画的窗口选项，CSS 够不着。
   * 2026-10-15 覆盖层删掉、窗口按钮改由应用自绘之后（M0 工单 1），
   * 配色归 CSS 令牌管，这条路整条不需要了。
   */
}

/**
 * 按当前设置与系统偏好应用一次。
 *
 * @param theme 用户选的档位
 * @returns 实际应用的是否深色
 */
export function applyTheme(theme: Theme): boolean {
  const prefersDark = typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
  const dark = resolvesToDark(theme, prefersDark);

  applyDark(dark);

  /*
   * 用户选了什么，另存一个属性。
   *
   * `data-theme` 必须**始终**是生效值 —— 我的深色是 CSS 选择器驱动的
   * （`[data-theme="dark"] .wb`），属性一缺就匹配不上，会出现
   * "系统是深色、界面却渲染成浅色"。
   *
   * 这一点与本体**有意偏离**：本体让属性缺失来表达「跟随系统」，
   * 因为它的颜色由 JS 读 `matchMedia` 直接决定、不依赖选择器。
   * 我保留 `data-theme` 常驻，另用这个属性记用户的选择。
   */
  if (theme === "system") {
    document.documentElement?.removeAttribute("data-theme-pref");
  } else {
    document.documentElement?.setAttribute("data-theme-pref", theme);
  }
  return dark;
}

/**
 * 下载入时应用一次。根组件调用 —— **不能只放在设置里**：
 * 设置类组件只在打开时挂载，启动时没人应用，于是本地存着深色、界面却是浅色。
 *
 * @returns 解除监听的函数
 */
export function startTheme(): () => void {
  let current = readTheme();
  applyTheme(current);

  // 「跟随系统」要在系统主题变化时**立刻**跟着变，而不是等下次启动
  const mq = typeof matchMedia === "function" ? matchMedia(DARK_QUERY) : null;
  const onChange = (): void => {
    if (current === "system") applyTheme(current);
  };
  mq?.addEventListener("change", onChange);

  return () => mq?.removeEventListener("change", onChange);
}

/**
 * 记下选择并立即生效。
 *
 * @param theme 要保存的档位
 * @returns 实际应用的是否深色
 */
export function saveTheme(theme: Theme): boolean {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 存不进去也要让它本次生效 —— 比"点了没反应"好 */
  }
  return applyTheme(theme);
}
