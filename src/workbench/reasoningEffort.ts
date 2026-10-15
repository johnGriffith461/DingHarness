import { isReasoningEffort, type ReasoningEffort } from "@engine/runtime/protocols/reasoning";

/**
 * **思考强度**的持久化（2026-10-16）。
 *
 * 与 `confirmMode.ts` 同一个形状（localStorage，读写都容错），理由也一样：
 * 它是**用户偏好**，不能在离开页面时悄悄回到默认；而且它要跨过 IPC 交给主进程，
 * 所以必须有一个"当前值"能被两边读到。
 *
 * ⚠️ 没选过 = `undefined`：那是"各家默认"，**不是**某一档。
 * 所以这里没有默认值 —— 只有用户明确点过某个档位才会有值。
 */

const KEY = "dsh-canvas.reasoning-effort";

/** 读出当前档位；没存过、存坏了、或是个野生值 → `undefined`（= 各家默认）。 */
export function readReasoningEffort(): ReasoningEffort | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    return isReasoningEffort(raw) ? raw : undefined;
  } catch {
    // 隐私模式 / 存储被禁用：回落即可，不该因此让输入区报错
    return undefined;
  }
}

/** 记住档位；传 `undefined` = 回到"各家默认"（把键删掉，而不是存个 "auto"）。 */
export function saveReasoningEffort(effort: ReasoningEffort | undefined): void {
  try {
    if (effort === undefined) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, effort);
  } catch {
    /* 存不进去也不影响这次会话里已经生效的选择 */
  }
}
