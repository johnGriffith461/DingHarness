import { beforeEach, describe, expect, it } from "vitest";
import { pickKeyDelete, pickKeyDeleteEdges } from "./keyDelete";
import { useRuntimeStore } from "./runtimeStore";
import type { CanvasNode } from "./types";
import { makeFrameNode, makeMarkdownNode } from "./types";

/**
 * 按 Delete/Backspace 删画框：**不许连带删掉框里的卡片**（2026-10-16 审计 P106）。
 *
 * ## 缺陷形状
 *
 * 画布上删除有两条路，取舍必须一致：
 *   · Ctrl+X / 右键「删除」/ 图层面板 → `store.removeSelected()`（把框里没被选中的卡片救回顶层）
 *   · React Flow 自带的删除键 → `@xyflow/system` 的 `getElementsToRemove()`，它把
 *     `parentId` 命中被删节点的**子节点一并收进删除集**
 *
 * 于是"选中画框按 Delete"会连带删掉框里的卡片 —— 与 store 里明示的取舍相反，
 * 同一个动作两个入口两种后果。
 *
 * 判据分两层：
 *   ① 纯函数 `pickKeyDelete` —— 从待删集里挑出"真的该删"的（连带项去掉）；
 *   ② `adoptOrphans` —— 被救下的子节点把坐标换成绝对、清掉 `parentId`（否则悬空父）。
 */

const frame = (id: string, x = 0, y = 0): CanvasNode => makeFrameNode(id, { x, y }, { width: 520, height: 380 });
const card = (id: string, position: { x: number; y: number }, parentId?: string): CanvasNode => ({
  ...makeMarkdownNode(id, position, "内容", { width: 120, height: 80 }),
  ...(parentId ? { parentId } : {}),
});

describe("pickKeyDelete：连带进来的子节点要摘出去", () => {
  it("⭐ 选中画框时，React Flow 连带进来的卡片**不算真该删**", () => {
    const doomed = [{ id: "fa" }, { id: "n1", parentId: "fa" }];
    expect(pickKeyDelete(doomed, new Set(["fa"])).map((n) => n.id)).toEqual(["fa"]);
  });

  it("用户自己也选中了那张卡片 → 一起删（不是硬性保护）", () => {
    const doomed = [{ id: "fa" }, { id: "n1", parentId: "fa" }];
    expect(pickKeyDelete(doomed, new Set(["fa", "n1"])).map((n) => n.id)).toEqual(["fa", "n1"]);
  });

  it("父不在待删集里 → 它本来就是被选中的，照删", () => {
    const doomed = [{ id: "n1", parentId: "fb" }];
    expect(pickKeyDelete(doomed, new Set(["n1"])).map((n) => n.id)).toEqual(["n1"]);
  });

  it("顶层节点照删（没有父，谈不上连带）", () => {
    const doomed = [{ id: "a" }, { id: "b" }];
    expect(pickKeyDelete(doomed, new Set(["a", "b"])).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("连线：被救下的子节点身上的线不跟着消失，用户选中的线照样删", () => {
    const survivors = new Set(["n1", "fa-kept"]);
    expect(
      pickKeyDeleteEdges(
        [
          { source: "n1", target: "n2" }, // n2 没被救回来 → 该删
          { source: "n1", target: "fa-kept" }, // 两端都在 → 留着
          { source: "x", target: "y", selected: true }, // 用户显式选了 → 删
        ],
        survivors,
      ).length,
    ).toBe(2);
  });
});

describe("adoptOrphans：救下来的子节点不能留着悬空父", () => {
  beforeEach(() => {
    useRuntimeStore.setState({ nodes: [], edges: [], revision: 0, markers: [], history: { past: [], future: [] } });
  });

  it("⭐ 父被删后：子节点 `parentId` 清掉、位置换成**绝对**坐标", () => {
    useRuntimeStore.setState({
      nodes: [frame("fa", 300, 200), card("n1", { x: 40, y: 30 }, "fa")],
    });
    useRuntimeStore.getState().adoptOrphans(["fa"]);
    const node = useRuntimeStore.getState().nodes.find((n) => n.id === "n1")!;
    expect(node.parentId).toBeUndefined();
    expect(node.position, "40+300 / 30+200 —— 还是相对坐标的话就跑到左上角去了").toEqual({ x: 340, y: 230 });
  });

  it("没有孤儿时不推修订号（别白造一次存档）", () => {
    useRuntimeStore.setState({ nodes: [card("n1", { x: 1, y: 2 })], revision: 7 });
    useRuntimeStore.getState().adoptOrphans(["ghost"]);
    expect(useRuntimeStore.getState().revision).toBe(7);
  });

  it("`removeSelected` 走的是**同一处**实现（两条删除路径取舍必须一致）", () => {
    useRuntimeStore.setState({
      nodes: [{ ...frame("fa", 100, 100), selected: true }, card("n1", { x: 10, y: 20 }, "fa")],
    });
    useRuntimeStore.getState().removeSelected();
    const nodes = useRuntimeStore.getState().nodes;
    expect(nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(nodes[0]!.parentId).toBeUndefined();
    expect(nodes[0]!.position).toEqual({ x: 110, y: 120 });
  });
});
