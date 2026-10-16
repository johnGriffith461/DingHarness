import { classifyFailure, failureMessage } from "@shared/errors";

/**
 * 界面上「出错了」那一行该写什么（2026-10-16 审计 P190 的**渲染侧**那一半）。
 *
 * ## 为什么要有这一层
 *
 * `shared/errors.ts` 收口的是**措辞**（"原因 → 一句话"），但出口没收口：
 * 仓里成片的界面代码直接把 `error.message` 拼进用户看得见的文案里 ——
 * 用户会看到 `ENOENT: no such file or directory, open 'C:\Users\...\kv.db'`
 * 这种堆栈式的东西，而同一句话在别的通道里早就被翻成「连不上 provider（检查网络…）」了。
 *
 * 所以这里补上"渲染侧的出错文案"这一个出口：
 *   · 认得出来的原因（限流 / 密钥 / 连不上 / 超时…）→ 走 `failureMessage` 那一句话（含下一步）；
 *   · **认不出来**的一律不把原文贴上界面 —— 原文进控制台（排查够用），
 *     界面上给一句"没料到的问题"并说明可以重试。
 *
 * ## 为什么放在 `src/canvas/` 下
 *
 * 用它的是画布（版本面板）与工作台（悬浮助手）两侧，而两侧的依赖方向是
 * **工作台 → 画布**（`canvasCommandHost` / `Workbench` 都这么引），所以放这一层不会成环。
 *
 * ## 它**不**处理的
 *
 * 我们自己写的文案（例如 `clipboard.ts` 抛的「画布内容无法序列化，已取消复制」）
 * 不该经过这里 —— 那句话本身就是人话，过一遍只会被压成"没料到的问题"。
 * 规矩是：**上游来的（系统 / SDK / HTTP / 引擎）才走这里**。
 */

/** 认不出来时界面上写的那一句（原文只进日志）。 */
export const UNKNOWN_FAILURE_LINE = "没料到的问题（可重试；详情见日志）";

/**
 * **我们自己**的终态文案：本来就不是上游原话，原样透出。
 *
 * `shared/errors.ts` 的 `classifyFailure` 只认英文 `abort`，而引擎发的终态消息是中文的
 * 「已中止」（`engine/core/events` 那条，见浮窗那颗停止键）。用户自己按的停止，
 * 不该被说成「没料到的问题」。
 */
const OUR_TERMINAL_LINES = new Set(["已中止"]);

/** 从任意抛出物里取出原始文本（`Error` 之外的也都认）。 */
function rawTextOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return String(error ?? "");
  } catch {
    /* `String()` 自己抛（`Symbol.toPrimitive` 被写坏之类）也不能让界面再炸一次 */
    return "";
  }
}

/**
 * 把一次失败翻成界面上一句话。
 *
 * @param error 捕获到的任意东西（`unknown`）
 * @returns 一句话（认得出来时含下一步；认不出来时是 `UNKNOWN_FAILURE_LINE`）
 */
export function uiError(error: unknown): string {
  const raw = rawTextOf(error);
  if (OUR_TERMINAL_LINES.has(raw)) return raw;
  const known = failureMessage(classifyFailure(raw));
  if (known) return known;
  /* 排查要的还是原文：进控制台，不上面 */
  console.error("[ui] 未归类的问题：", raw);
  return UNKNOWN_FAILURE_LINE;
}
