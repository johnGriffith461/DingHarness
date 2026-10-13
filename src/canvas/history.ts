import type { Edge, Node } from "@xyflow/react";

/**
 * 撤销栈的纯逻辑（对标原版 `addToHistory`）。
 *
 * 阶段 1 用整图快照，够用且简单；阶段 4 接 revision 后这里换成增量 patch。
 * 接入点只有两处：`runtimeStore.ts`（commitHistory / undoHistory / redoHistory）
 * 与它的单测，改内部结构不影响画布。
 */

/** 一帧画布状态（节点 + 边）。 */
export type CanvasSnapshot = { nodes: Node[]; edges: Edge[] };

export type CanvasHistory = {
  past: CanvasSnapshot[];
  future: CanvasSnapshot[];
};

const MAX_PAST = 100;

export function createHistoryState(): CanvasHistory {
  return { past: [], future: [] };
}

/** 压入一帧，并清空重做栈（新动作让旧的重做分支失效）。 */
export function pushHistory(state: CanvasHistory, snapshot: CanvasSnapshot): CanvasHistory {
  const past = [...state.past, snapshot];
  if (past.length > MAX_PAST) past.splice(0, past.length - MAX_PAST);
  return { past, future: [] };
}

/** 撤销：弹出上一帧作为落点。没有可撤销时原样返回。 */
export function undoHistory(state: CanvasHistory): { state: CanvasHistory; apply: CanvasSnapshot | null } {
  if (state.past.length === 0) return { state, apply: null };
  const apply = state.past[state.past.length - 1];
  return { state: { past: state.past.slice(0, -1), future: state.future }, apply };
}

/**
 * 重做：与撤销对称。
 * @param state 当前历史栈
 * @param current 重做前把"当前帧"存回撤销栈，保证可反复前进后退
 */
export function redoHistory(
  state: CanvasHistory,
  current: CanvasSnapshot,
): { state: CanvasHistory; apply: CanvasSnapshot | null } {
  if (state.future.length === 0) return { state, apply: null };
  const apply = state.future[state.future.length - 1];
  return {
    state: { past: [...state.past, current], future: state.future.slice(0, -1) },
    apply,
  };
}

export function canUndo(state: CanvasHistory): boolean {
  return state.past.length > 0;
}

export function canRedo(state: CanvasHistory): boolean {
  return state.future.length > 0;
}
