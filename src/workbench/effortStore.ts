import { create } from "zustand";

import { isReasoningEffort, type ReasoningEffort } from "@engine/runtime/protocols/reasoning";

/**
 * 思考强度的**唯一一份状态**（2026-10-16，主人的话：「这个东西应该默认跟主页面
 * 那个对话的思考强度是一样的」）。
 *
 * ## 为什么要有这个 store
 *
 * 第一版把它做成了两处各自的 `useState`（主页那颗 chip 一份、画布对话侧栏一份），
 * 但**读写同一个 localStorage 键**。那有个真问题：两处在同一次运行里各存了一份内存状态 ——
 * 在一边改了，另一边直到重新挂载才会看到新值。用户看到的是"同一个设置在两处显示不一样"，
 * 而这正是这类选择器最容易烂的地方。
 *
 * 现在：**状态只有这一份**，两处都从这里读、都往这里写；写的时候顺手落盘
 * （`localStorage`，与非 React 的调用方共用同一个键 —— 请求发起时读的就是它）。
 *
 * ⚠️ `effort === undefined` 是**合法值**，意思是"各家自己的默认"（一个字段都不发），
 * 所以不要用 `null`、也不要在没有值时编一个档位出来。
 */

const KEY = "dsh-canvas.reasoning-effort";

/** 从盘上读（**非 React 的调用方**也用它：请求发起时要知道当前档位）。 */
export function readReasoningEffort(): ReasoningEffort | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    return isReasoningEffort(raw) ? raw : undefined;
  } catch {
    // 隐私模式 / 存储被禁用：回落即可，不该因此让输入区报错
    return undefined;
  }
}

/** 落盘（写不进去也不影响这一次会话里已经生效的选择）。 */
function writeReasoningEffort(effort: ReasoningEffort | undefined): void {
  try {
    if (effort === undefined) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, effort);
  } catch {
    /* 同上 */
  }
}

type EffortState = {
  effort: ReasoningEffort | undefined;
  /** 选一档（`undefined` = 回到"各家默认"）。 */
  setEffort: (effort: ReasoningEffort | undefined) => void;
};

export const useEffortStore = create<EffortState>((set) => ({
  effort: readReasoningEffort(),
  setEffort: (effort) => {
    writeReasoningEffort(effort);
    set({ effort });
  },
}));
