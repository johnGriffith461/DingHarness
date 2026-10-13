import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import {
  canRedo,
  canUndo,
  createHistoryState,
  pushHistory,
  redoHistory,
  undoHistory,
} from "./history";
import type { CanvasHistory, CanvasSnapshot } from "./history";

/** 造一帧只有位置差异的快照。 */
function snap(x: number, edges: CanvasSnapshot["edges"] = []): CanvasSnapshot {
  const node: Node = { id: "n1", position: { x, y: 0 }, data: {} };
  return { nodes: [node], edges };
}

/** 压入一帧的便捷写法。 */
function push(state: CanvasHistory, frame: CanvasSnapshot): CanvasHistory {
  return pushHistory(state, frame);
}

describe("撤销栈", () => {
  it("新栈不能撤销也不能重做", () => {
    const s = createHistoryState();
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(false);
  });

  it("压入后能撤销，撤销落点是最近压入的那一帧", () => {
    let s = createHistoryState();
    s = push(s, snap(10));
    s = push(s, snap(20));
    expect(canUndo(s)).toBe(true);

    const step = undoHistory(s);
    expect(step.apply?.nodes[0].position.x).toBe(20);
    expect(step.state.past).toHaveLength(1);
    expect(canRedo(step.state)).toBe(false); // 只做纯逻辑：重做栈由调用方补当前帧
  });

  it("空栈撤销是空操作，原状态不变", () => {
    const s = createHistoryState();
    const step = undoHistory(s);
    expect(step.apply).toBeNull();
    expect(step.state).toBe(s);
  });

  it("撤销后重做能回到撤销前的状态", () => {
    let s = createHistoryState();
    s = push(s, snap(10));
    s = push(s, snap(20));
    // 模拟调用方：撤销时把"当前帧"放进重做栈
    const live = snap(30);
    const undone = undoHistory(s);
    s = { past: undone.state.past, future: [...undone.state.future, live] };
    expect(undone.apply?.nodes[0].position.x).toBe(20);
    expect(canRedo(s)).toBe(true);

    const redone = redoHistory(s, snap(20));
    expect(redone.apply?.nodes[0].position.x).toBe(30);
    expect(redone.state.past).toHaveLength(2);
    expect(canRedo(redone.state)).toBe(false);
  });

  it("新的动作清空重做栈（旧的前进分支失效）", () => {
    let s = createHistoryState();
    s = push(s, snap(10));
    s = { past: s.past, future: [snap(99)] };
    expect(canRedo(s)).toBe(true);
    s = push(s, snap(20));
    expect(canRedo(s)).toBe(false);
  });

  it("容量上限 100：超出后丢最旧的一帧", () => {
    let s = createHistoryState();
    for (let i = 0; i < 130; i += 1) s = push(s, snap(i));
    expect(s.past).toHaveLength(100);
    // 保留的是最近 100 帧：最旧一帧应为第 30 次压入的 30
    expect(s.past[0].nodes[0].position.x).toBe(30);
    expect(s.past[99].nodes[0].position.x).toBe(129);
  });

  it("边也随快照一起进出（整图快照，不是只记节点）", () => {
    let s = createHistoryState();
    const edge = { id: "e1", source: "n1", target: "n2" };
    s = push(s, snap(10, [edge]));
    const step = undoHistory(s);
    expect(step.apply?.edges).toEqual([edge]);
  });
});
