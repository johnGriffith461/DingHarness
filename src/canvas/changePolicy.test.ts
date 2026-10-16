import { describe, expect, it } from "vitest";
import { edgesAreStructural, nodesAreStructural } from "./changePolicy";

/**
 * 变更分类（2026-10-16 审计 P22）。
 *
 * ⚠️ 这一条守的是**手感**：判错的后果不是崩溃，而是"打字把撤销栈灌满" ——
 * `replace` 每次击键都来一条（`updateNodeData` 那条路），算成结构性的就一个键一个撤销点，
 * 用户按 Ctrl+Z 得按二十下。用户不会报"撤销栈有二十条"，只会说"Ctrl+Z 按不动"。
 */
describe("P22：节点侧的 `replace` 不算结构性变更", () => {
  it("⭐ 只有 replace（打字改内容）→ 不打撤销点", () => {
    expect(
      nodesAreStructural([{ type: "replace" }]),
      "又把 replace 算成结构性了 —— 一次击键一个撤销点（连续输入的合并窗口被绕过）",
    ).toBe(false);
  });

  it("remove 算（真的删了东西）", () => {
    expect(nodesAreStructural([{ type: "remove" }])).toBe(true);
  });

  it("select / dimensions 不算（选择态与测量是视图层面的事）", () => {
    expect(nodesAreStructural([{ type: "select" }, { type: "dimensions" }])).toBe(false);
  });

  it("拖动的中间帧（position）也不算（它由拖动起点的那个撤销点负责）", () => {
    expect(nodesAreStructural([{ type: "position", dragging: true } as { type: string }])).toBe(false);
  });

  it("一条 remove 混在一堆 replace 里 → 算（不能因为先看的那条是 replace 就漏掉）", () => {
    expect(nodesAreStructural([{ type: "replace" }, { type: "remove" }, { type: "replace" }])).toBe(true);
  });
});

describe("连线侧：`replace` 要算（那是重连，真的改了图）", () => {
  it("replace 算结构性", () => {
    expect(edgesAreStructural([{ type: "replace" }])).toBe(true);
  });

  it("select 不算", () => {
    expect(edgesAreStructural([{ type: "select" }])).toBe(false);
  });
});
