import { beforeEach, describe, expect, it } from "vitest";
import { useRuntimeStore } from "./runtimeStore";
import { toAbsolute } from "./frames";
import type { CanvasNode } from "./types";
import { makeFrameNode, makeMarkdownNode } from "./types";

/**
 * 画框归属的坐标换算（2026-10-16 审计 P248）。
 *
 * ## 缺陷形状（这是本轮最典型的"看着对、其实错一半"）
 *
 * `planAdoption` 判"谁该进画框"用的是**绝对坐标**（对，它走了 `toAbsolute`），
 * 而 `syncFrameMembership` 写回时用的是 `n.position` **直接加减** 画框位置 ——
 * 对子节点来说 `n.position` 是**相对它自己那个父**的。于是"把卡片从画框 B 拖进画框 A"
 * 会因为漏掉 B 的偏移而**瞬移**（松手就飞走）。
 *
 * 判据取"**绝对坐标必须守恒**"：换归属不该改变卡片在画布上的位置，只该改变它挂在谁下面。
 */

const frameA = (x: number, y: number) => makeFrameNode("fa", { x, y }, { width: 520, height: 380 });
const frameB = (x: number, y: number) => makeFrameNode("fb", { x, y }, { width: 520, height: 380 });

/** 卡片：`parentId` 给定时，`position` 是**相对那个父**的（React Flow 约定）。 */
const card = (id: string, position: { x: number; y: number }, parentId?: string): CanvasNode => ({
  ...makeMarkdownNode(id, position, "内容", { width: 120, height: 80 }),
  ...(parentId ? { parentId } : {}),
});

function absoluteOf(id: string): { x: number; y: number } {
  const nodes = useRuntimeStore.getState().nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const node = byId.get(id);
  if (!node) throw new Error(`没有 ${id} 这个节点`);
  return toAbsolute(node, byId);
}

beforeEach(() => {
  useRuntimeStore.setState({
    nodes: [],
    edges: [],
    revision: 0,
    markers: [],
    history: { past: [], future: [] },
  });
});

describe("P248：跨画框改归属时卡片不许瞬移", () => {
  it("⭐ 卡片从 B 拖进 A：绝对位置守恒（漏掉旧父偏移就会飞走）", () => {
    /*
     * 布局：两个画框错开。卡片此刻挂在 B 下，`position` 是相对 B 的 (50, 40)。
     * 它在 B 里的绝对位置 = B(400,300) + (50,40) = (450, 340)，
     * 而 A 在 (0,0)、A 的框是 520×380 —— 中心点 (450+60, 340+40) = (510, 380) 正好在 A 内（边界算内）。
     */
    useRuntimeStore.setState({
      nodes: [frameA(0, 0), frameB(400, 300), card("n1", { x: 50, y: 40 }, "fb")],
    });
    const before = absoluteOf("n1");
    expect(before, "夹具本身要立得住：卡片此刻在 (450,340)").toEqual({ x: 450, y: 340 });

    useRuntimeStore.getState().syncFrameMembership("fa");

    const node = useRuntimeStore.getState().nodes.find((n) => n.id === "n1")!;
    expect(node.parentId, "它该改挂到 A 下").toBe("fa");
    expect(
      absoluteOf("n1"),
      "换归属改的是「挂在谁下面」，不该改变它在画布上的位置 —— 变了就是 P248 那个瞬移",
    ).toEqual(before);
    /* 再确认一次：存的是**相对 A** 的坐标（A 在原点，所以数值恰好相同） */
    expect(node.position).toEqual({ x: 450, y: 340 });
  });

  it("⭐ 画框不在原点时同样守恒（这是原实现最容易漏的一处）", () => {
    // A 挪到 (700, 500)：相对坐标 = 绝对 − A 的绝对位置
    useRuntimeStore.setState({
      nodes: [frameA(700, 500), frameB(400, 300), card("n1", { x: 50, y: 40 }, "fb")],
    });
    const before = absoluteOf("n1");
    // A 的框：(700,500)-(1220,880)，卡片中心 (510,380) 不在里面 → 先把卡片挪进 A
    useRuntimeStore.setState((s) => ({
      nodes: s.nodes.map((n) => (n.id === "n1" ? { ...n, position: { x: 100, y: 60 } } : n)),
    }));
    const moved = absoluteOf("n1");
    expect(moved, "卡片现在在 (500,360)（绝对）").toEqual({ x: 500, y: 360 });
    expect(moved, "离 A 还远，先断言它确实不在 A 的框里").not.toBe(before);

    useRuntimeStore.getState().syncFrameMembership("fa");
    expect(useRuntimeStore.getState().nodes.find((n) => n.id === "n1")!.parentId, "不在 A 的框里，不该被收").toBe("fb");

    // 现在把它放进 A 的框里（绝对 (750, 540)）→ 相对 B 的坐标 = (350, 240)
    useRuntimeStore.setState((s) => ({
      nodes: s.nodes.map((n) => (n.id === "n1" ? { ...n, position: { x: 350, y: 240 } } : n)),
    }));
    const insideA = absoluteOf("n1");
    expect(insideA).toEqual({ x: 750, y: 540 });

    useRuntimeStore.getState().syncFrameMembership("fa");
    const node = useRuntimeStore.getState().nodes.find((n) => n.id === "n1")!;
    expect(node.parentId).toBe("fa");
    expect(absoluteOf("n1"), "绝对位置必须还是 (750,540)，而不是「相对 B 的坐标 − A 的位置」").toEqual(insideA);
    expect(node.position, "存的是相对 A 的 (50,40)").toEqual({ x: 50, y: 40 });
  });

  it("拖出画框回到顶层：绝对坐标同样守恒", () => {
    useRuntimeStore.setState({
      nodes: [frameA(200, 100), card("n1", { x: 30, y: 20 }, "fa")],
    });
    const before = absoluteOf("n1");
    expect(before).toEqual({ x: 230, y: 120 });

    // 挪到框外（绝对 (900,900)）→ 相对 A 的 (700, 800)
    useRuntimeStore.setState((s) => ({
      nodes: s.nodes.map((n) => (n.id === "n1" ? { ...n, position: { x: 700, y: 800 } } : n)),
    }));
    useRuntimeStore.getState().syncFrameMembership("fa");
    const node = useRuntimeStore.getState().nodes.find((n) => n.id === "n1")!;
    expect(node.parentId).toBeUndefined();
    expect(node.position, "放回顶层时存的必须是绝对坐标").toEqual({ x: 900, y: 900 });
  });

  it("幂等：已经在框里且已挂在该框下 → 不产生变更（不白推修订号）", () => {
    useRuntimeStore.setState({
      nodes: [frameA(0, 0), card("n1", { x: 100, y: 100 }, "fa")],
    });
    const revision = useRuntimeStore.getState().revision;
    useRuntimeStore.getState().syncFrameMembership("fa");
    expect(useRuntimeStore.getState().revision).toBe(revision);
  });
});
