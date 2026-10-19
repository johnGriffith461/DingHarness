import type { ConfirmRequest } from "./ConfirmDialog";

/**
 * T-04：清空记忆的确认请求（纯函数，便于单测）。
 *
 * 文案的三条要求：
 * 1. **说清条数**——用户要知道会丢多少；
 * 2. **说清不可撤销**——这份数据没有回收站；
 * 3. 确认按钮写**动作**（"清空 N 条"），不写"确定"。
 */
export function clearConfirmRequest(count: number): ConfirmRequest {
  const n = Math.max(0, Math.floor(count));
  return {
    title: "清空全部记忆？",
    message: `将清空全部 ${n} 条记忆，不可撤销。`,
    detail: "清空后这些内容不会再随对话注入系统提示词；要保留就先复制出去。",
    confirmLabel: `清空 ${n} 条`,
    danger: true,
  };
}
