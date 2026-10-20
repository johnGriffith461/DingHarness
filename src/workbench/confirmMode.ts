import { normalizeConfirmMode, type ConfirmMode } from "@shared/ipc";

/**
 * 审批档位的持久化（§143）。
 *
 * ## 为什么必须存
 *
 * 那个 chip 原来是 `useState("全部允许")` —— **局部 state**。它有两个后果：
 * ① 用户选了「每步确认」，离开再回来就变回「全部允许」（没人读它，自然也没人存它）；
 * ② 主进程的工具执行层**根本拿不到**这个选择，所以闸没法接在判定上。
 *
 * 存法沿用本机既有做法（`localStorage`，与 `dsh-canvas.chat-settings` 同期）。
 */

const KEY = "dsh-canvas.confirm-mode";

/**
 * 档位变化通知（F-04）。
 *
 * 原来档位只存在 localStorage，`TaskView` 这类"不在输入区里"的组件读一次就永远不会更新 ——
 * 于是"点了本会话自动接受"之后，逃生门卡片还挂在那里。保存处统一通知，订阅方重渲染。
 */
const listeners = new Set<() => void>();

/**
 * **只在本会话生效**的档位（F-04 的「本会话自动接受」）。
 *
 * 为什么不写 localStorage：那里的值**跨重启**还在，而按钮上写的是"本会话"——
 * 写进去就等于骗人（用户重启后会发现所有编辑都不再问）。
 * 模块级变量在进程重启时自然消失，正是"本会话"的语义。
 */
let sessionOverride: ConfirmMode | null = null;

export function subscribeConfirmMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 读出当前档位；没存过或存坏了都回落到「按需确认」（Phase 11.5 的安全默认档）。 */
export function readConfirmMode(): ConfirmMode {
  if (sessionOverride) return sessionOverride;
  try {
    return normalizeConfirmMode(localStorage.getItem(KEY));
  } catch {
    // 隐私模式 / 存储被禁用：回落即可，不该因此让输入区报错
    return "按需确认";
  }
}

/**
 * 记住档位。
 *
 * @param opts.sessionOnly `true` = 只改本进程，不写盘（F-04 的逃生门按钮）。
 *   普通改档位（输入区 chip / 首跑向导）仍然落盘 —— 那是用户的显式长期选择。
 */
export function saveConfirmMode(mode: ConfirmMode, opts: { sessionOnly?: boolean } = {}): void {
  if (opts.sessionOnly) {
    sessionOverride = mode;
  } else {
    sessionOverride = null;
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* 存不进去也不影响这次会话里已经生效的选择 */
    }
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 一个订阅者坏了不该带走别的 */
    }
  }
}

/**
 * T-06：档位弹层里一个选项的状态（**纯函数**，供界面与单测共用）。
 *
 * `marker` 只有两种取值：
 * - `check` —— 当前档位，画一个勾；
 * - `none` —— 其它档位，**不画任何勾**（原来每个选项前面都画了一个 Check，
 *   于是三个选项全有勾，用户看不出自己在哪一档）。
 */
export function confirmOptionState(
  mode: ConfirmMode,
  current: ConfirmMode,
): { checked: boolean; marker: "check" | "none" } {
  const checked = mode === current;
  return { checked, marker: checked ? "check" : "none" };
}
