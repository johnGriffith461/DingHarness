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

/** 读出当前档位；没存过或存坏了都回落到「按需确认」（Phase 11.5 的安全默认档）。 */
export function readConfirmMode(): ConfirmMode {
  try {
    return normalizeConfirmMode(localStorage.getItem(KEY));
  } catch {
    // 隐私模式 / 存储被禁用：回落即可，不该因此让输入区报错
    return "按需确认";
  }
}

/** 记住档位。 */
export function saveConfirmMode(mode: ConfirmMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* 存不进去也不影响这次会话里已经生效的选择 */
  }
}
