import { describe, expect, it } from "vitest";
import { childrenOf, nodeBox, planAdoption, pointIn, toAbsolute } from "./frames";
import type { CanvasNode } from "./types";
import { makeFrameNode, makeMarkdownNode } from "./types";

const frame = { x: 0, y: 0, width: 520, height: 380 };

describe("pointIn / nodeBox", () => {
  it("边界算在内", () => {
    expect(pointIn(frame, { x: 0, y: 0 })).toBe(true);
    expect(pointIn(frame, { x: 520, y: 380 })).toBe(true);
    expect(pointIn(frame, { x: 521, y: 0 })).toBe(false);
  });

  it("没有测量尺寸时退回兜底尺寸", () => {
    expect(nodeBox({ position: { x: 10, y: 20 } })).toEqual({ x: 10, y: 20, width: 320, height: 200 });
  });

  it("有测量尺寸时用真实尺寸", () => {
    expect(nodeBox({ position: { x: 0, y: 0 }, width: 100, height: 50 })).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
  });
});

describe("childrenOf", () => {
  const inside = { ...makeMarkdownNode("in", { x: 100, y: 100 }, "x"), width: 200, height: 120 };
  const straddling = { ...makeMarkdownNode("straddle", { x: 480, y: 100 }, "x"), width: 200, height: 120 };
  const outside = { ...makeMarkdownNode("out", { x: 900, y: 900 }, "x"), width: 200, height: 120 };

  it("中心在框内的算归属", () => {
    expect(childrenOf([inside] as never, "f1", frame)).toEqual(["in"]);
  });

  it("只是边缘擦到、中心在外面的**不算**（否则拖画框会莫名其妙带走别人的卡片）", () => {
    expect(childrenOf([straddling] as never, "f1", frame)).toEqual([]);
  });

  it("远处的节点不归属", () => {
    expect(childrenOf([outside] as never, "f1", frame)).toEqual([]);
  });

  it("画框自己不是自己的子节点", () => {
    const self = makeFrameNode("f1", { x: 0, y: 0 });
    expect(childrenOf([self] as never, "f1", frame)).toEqual([]);
  });

  it("画框不能被另一个画框框住（嵌套会成环）", () => {
    const other = makeFrameNode("f2", { x: 10, y: 10 });
    expect(childrenOf([other] as never, "f1", frame)).toEqual([]);
  });

  it("多个命中按输入顺序返回", () => {
    const a = { ...makeMarkdownNode("a", { x: 10, y: 10 }, "x"), width: 100, height: 100 };
    const b = { ...makeMarkdownNode("b", { x: 300, y: 200 }, "x"), width: 100, height: 100 };
    expect(childrenOf([a, b] as never, "f1", frame)).toEqual(["a", "b"]);
  });
});

describe("toAbsolute", () => {
  it("无父节点时就是自身位置", () => {
    const byId = new Map([["n1", { id: "n1", position: { x: 5, y: 7 } }]]);
    expect(toAbsolute({ id: "n1", position: { x: 5, y: 7 } }, byId as never)).toEqual({ x: 5, y: 7 });
  });

  it("有父节点时累加父的位置（子节点存的是相对坐标）", () => {
    const byId = new Map([
      ["f1", { id: "f1", position: { x: 100, y: 200 } }],
      ["n1", { id: "n1", position: { x: 10, y: 20 }, parentId: "f1" }],
    ]);
    expect(toAbsolute({ id: "n1", position: { x: 10, y: 20 }, parentId: "f1" }, byId as never)).toEqual({
      x: 110,
      y: 220,
    });
  });

  it("父节点不存在时不炸（历史数据缺父时也要能算）", () => {
    const byId = new Map<string, { id: string; position: { x: number; y: number } }>();
    expect(toAbsolute({ id: "n1", position: { x: 1, y: 2 }, parentId: "gone" }, byId)).toEqual({ x: 1, y: 2 });
  });
});

describe("planAdoption", () => {
  it("框内的节点被收进来", () => {
    const f = makeFrameNode("f1", { x: 0, y: 0 }, { width: 520, height: 380 });
    const inner = { ...makeMarkdownNode("n1", { x: 100, y: 100 }, "x"), width: 120, height: 80 };
    const plan = planAdoption([f, inner] as CanvasNode[], "f1");
    expect(plan.adopt).toEqual(["n1"]);
    expect(plan.release).toEqual([]);
  });

  it("被拖出画框的节点会解除归属", () => {
    const f = makeFrameNode("f1", { x: 0, y: 0 }, { width: 520, height: 380 });
    const out = {
      ...makeMarkdownNode("n1", { x: 900, y: 900 }, "x"),
      width: 120,
      height: 80,
      parentId: "f1",
    };
    const plan = planAdoption([f, out] as CanvasNode[], "f1");
    expect(plan.adopt).toEqual([]);
    expect(plan.release).toEqual(["n1"]);
  });

  it("已经在框内、已是子节点：既不收也不放（幂等，不产生空变更）", () => {
    const f = makeFrameNode("f1", { x: 0, y: 0 }, { width: 520, height: 380 });
    const inner = {
      ...makeMarkdownNode("n1", { x: 100, y: 100 }, "x"),
      width: 120,
      height: 80,
      parentId: "f1",
      // 子节点存相对坐标：相对画框 (100,100)
      position: { x: 100, y: 100 },
    };
    const plan = planAdoption([f, inner] as CanvasNode[], "f1");
    expect(plan.adopt).toEqual([]);
    expect(plan.release).toEqual([]);
  });

  it("画框位置不为零时判定仍正确（用绝对坐标）", () => {
    const f = makeFrameNode("f1", { x: 1000, y: 500 }, { width: 520, height: 380 });
    const inner = { ...makeMarkdownNode("n1", { x: 1100, y: 600 }, "x"), width: 120, height: 80 };
    const plan = planAdoption([f, inner] as CanvasNode[], "f1");
    expect(plan.adopt).toEqual(["n1"]);
  });

  it("传进来的不是画框时返回空计划", () => {
    const n = makeMarkdownNode("n1", { x: 0, y: 0 }, "x");
    expect(planAdoption([n] as CanvasNode[], "n1")).toEqual({ adopt: [], release: [] });
  });
});
