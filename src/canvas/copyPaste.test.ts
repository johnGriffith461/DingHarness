import { beforeEach, describe, expect, it } from "vitest";
import { planPaste, parseClipboard, serializeClipboard } from "./clipboard";
import { useRuntimeStore } from "./runtimeStore";
import type { CanvasNode } from "./types";
import { makeFrameNode, makeMarkdownNode } from "./types";

/**
 * 复制 / 粘贴 / 复制画框时的 `parentId`（2026-10-16 审计 P24）。
 *
 * ## 缺陷形状（两半）
 *
 * ① `planPaste` 的落点把**相对坐标与绝对坐标混在一起**取最小值（子节点存的是相对父的坐标），
 *    还让 `parentId` 靠对象展开**原样带走** —— 于是"从画框里复制一张卡片、粘到别处"
 *    之后，新卡片仍然挂在**原来那个画框**上（画框根本没被复制过来），按相对坐标乱放。
 * ② `duplicateSelected` 同理：复制"画框 + 框里的卡片"时，复制体的 `parentId` 指着**原框**，
 *    于是新框是空的、卡片还在原框里。
 *
 * 判据：**父在复制/粘贴集里就跟着映射，不在就落到顶层**；落点按绝对坐标算。
 */

const frame = (id: string, x = 0, y = 0): CanvasNode => makeFrameNode(id, { x, y }, { width: 520, height: 380 });
const card = (id: string, position: { x: number; y: number }, parentId?: string): CanvasNode => ({
  ...makeMarkdownNode(id, position, "内容", { width: 100, height: 60 }),
  ...(parentId ? { parentId } : {}),
});

describe("planPaste：`parentId` 与落点", () => {
  it("⭐ 只复制框里的卡片：粘出来的**不许还挂在原框上**（框没跟着过来）", () => {
    const payload = parseClipboard(serializeClipboard([card("n1", { x: 20, y: 30 }, "fa")], []))!;
    const plan = planPaste(payload, [frame("fa")], { x: 0, y: 0 });
    expect(plan.nodes[0]!.parentId, "原样带走 parentId → 新卡片挂在别人的框里、按相对坐标乱放").toBeUndefined();
  });

  it("⭐ 画框与卡片一起复制：卡片改挂到**复制出来的那个框**上，且相对坐标正确", () => {
    const payload = parseClipboard(
      serializeClipboard([frame("fa", 100, 50), card("n1", { x: 20, y: 30 }, "fa")], []),
    )!;
    const plan = planPaste(payload, [], { x: 1000, y: 800 });
    const newFrame = plan.nodes.find((n) => n.type === "frame")!;
    const newCard = plan.nodes.find((n) => n.type !== "frame")!;
    expect(newCard.parentId, "卡片要挂在复制出来的框下").toBe(newFrame.id);
    expect(newFrame.position, "整批的左上角落在锚点").toEqual({ x: 1000, y: 800 });
    expect(newCard.position, "相对新框的坐标 = 原来的相对坐标（20,30）").toEqual({ x: 20, y: 30 });
  });

  it("⭐ 落点按**绝对**坐标算：混算相对坐标会把锚点算歪（P24 的另一半）", () => {
    // 卡片在框 (500,400) 里、相对坐标 (10,20) → 绝对 (510,420)
    const payload = parseClipboard(
      serializeClipboard([frame("fa", 500, 400), card("n1", { x: 10, y: 20 }, "fa")], []),
    )!;
    const plan = planPaste(payload, [], { x: 0, y: 0 });
    const newFrame = plan.nodes.find((n) => n.type === "frame")!;
    expect(newFrame.position, "整批左上角（这里就是框自己）落在 (0,0)").toEqual({ x: 0, y: 0 });
  });

  it("没有父的普通粘贴：行为与原来一致（锚点落在外接框左上角）", () => {
    const payload = parseClipboard(
      serializeClipboard([card("a", { x: 100, y: 50 }), card("b", { x: 300, y: 90 })], []),
    )!;
    const plan = planPaste(payload, [], { x: 500, y: 700 });
    const xs = plan.nodes.map((n) => n.position.x);
    expect(Math.min(...xs)).toBe(500);
    expect(xs).toContain(700);
  });
});

describe("duplicateSelected：复制画框要连卡片一起进新框", () => {
  beforeEach(() => {
    useRuntimeStore.setState({ nodes: [], edges: [], revision: 0, markers: [], history: { past: [], future: [] } });
  });

  it("⭐ 复制「画框 + 框里卡片」：卡片挂在**复制出来的框**下，不回到原框", () => {
    useRuntimeStore.setState({
      nodes: [
        { ...frame("fa", 100, 100), selected: true },
        { ...card("n1", { x: 20, y: 30 }, "fa"), selected: true },
      ],
    });
    const created = useRuntimeStore.getState().duplicateSelected(28);
    const nodes = useRuntimeStore.getState().nodes;
    const newFrame = nodes.find((n) => n.type === "frame" && n.id !== "fa")!;
    const newCard = nodes.find((n) => n.type !== "frame" && n.id !== "n1")!;
    expect(created).toContain(newFrame.id);
    expect(newCard.parentId, "复制体的 parentId 指着原框 → 新框是空的（这就是 P24 后半句）").toBe(newFrame.id);
  });

  it("⭐ 父节点必须排在子节点前面（React Flow 的硬性要求）", () => {
    useRuntimeStore.setState({
      nodes: [
        { ...card("n1", { x: 20, y: 30 }, "fa"), selected: true },
        { ...frame("fa", 100, 100), selected: true },
      ],
    });
    useRuntimeStore.getState().duplicateSelected(28);
    const nodes = useRuntimeStore.getState().nodes;
    for (const n of nodes) {
      if (!n.parentId) continue;
      expect(
        nodes.findIndex((x) => x.id === n.parentId),
        `${n.id} 的父排在它后面 —— React Flow 会报 Parent node not found`,
      ).toBeLessThan(nodes.findIndex((x) => x.id === n.id));
    }
  });

  it("只复制框里的一张卡片：仍留在原框里（同框内原地复制是正确语义）", () => {
    useRuntimeStore.setState({ nodes: [frame("fa", 100, 100), { ...card("n1", { x: 20, y: 30 }, "fa"), selected: true }] });
    useRuntimeStore.getState().duplicateSelected(28);
    const copy = useRuntimeStore.getState().nodes.find((n) => n.id !== "n1" && n.type !== "frame")!;
    expect(copy.parentId).toBe("fa");
    expect(copy.position, "相对坐标直接加偏移（同一个坐标系）").toEqual({ x: 48, y: 58 });
  });
});
