/**
 * Plan 模式开关（C1）：**每个工作台会话共用一个开关**，存在 localStorage。
 *
 * 为什么不放 `WorkTask`：它是一轮对话里的"临时工作方式"，不是任务的长期身份；
 * 关掉应用之后重新打开，保持上一次的选择更符合直觉（与确认档位同一做法）。
 */

const KEY = "ding.planMode";

export function readPlanMode(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function savePlanMode(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* 无 localStorage（测试/无窗）→ 只在内存里生效，不影响功能 */
  }
}
