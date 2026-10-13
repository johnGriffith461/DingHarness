import { describe, expect, it } from "vitest";
import type { InternalNode, Node } from "@xyflow/react";
import {
  expandRect,
  hitTestRect,
  pointInRect,
  rectFromJourney,
  rectsIntersect,
} from "./nodeRect";
import type { Rect } from "./nodeRect";

/** 造一个 React Flow 内部节点表（节点在世界坐标 (x, y)，尺寸由 measured 给出）。 */
function lookupOf(entries: Array<[string, number, number, number?, number?]>) {
  const map = new Map<string, InternalNode<Node>>();
  for (const [id, x, y, w = 200, h = 120] of entries) {
    // nodeRect() 认 internals.positionAbsolute 作为"已测量的内部节点"标志
    map.set(id, {
      id,
      type: "text",
      position: { x, y },
      data: {},
      measured: { width: w, height: h },
      internals: { positionAbsolute: { x, y }, z: 0 },
    } as unknown as InternalNode<Node>);
  }
  return map;
}

describe("rectFromJourney", () => {
  it("反向拖拽也能得到正的外接矩形", () => {
    expect(rectFromJourney({ x: 300, y: 200 }, { x: 100, y: 50 })).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 150,
    });
  });

  it("原地点按退化成零面积矩形（对应点选）", () => {
    expect(rectFromJourney({ x: 10, y: 10 }, { x: 10, y: 10 })).toEqual({
      x: 10,
      y: 10,
      width: 0,
      height: 0,
    });
  });
});

describe("矩形基本判定", () => {
  const rect: Rect = { x: 100, y: 100, width: 200, height: 100 };

  it("点在矩形内（含边界）", () => {
    expect(pointInRect({ x: 100, y: 100 }, rect)).toBe(true);
    expect(pointInRect({ x: 300, y: 200 }, rect)).toBe(true);
    expect(pointInRect({ x: 301, y: 150 }, rect)).toBe(false);
  });

  it("贴边算相交，隔一条缝不算", () => {
    // rect 占 x∈[100,300] / y∈[100,200]，贴边块从 x=300 起算相交，从 x=301 起留缝
    expect(rectsIntersect(rect, { x: 300, y: 150, width: 50, height: 50 })).toBe(true);
    expect(rectsIntersect(rect, { x: 301, y: 150, width: 50, height: 50 })).toBe(false);
  });

  it("外扩容差把边界外的点也纳进来", () => {
    expect(pointInRect({ x: 96, y: 96 }, rect)).toBe(false);
    expect(pointInRect({ x: 96, y: 96 }, expandRect(rect, 8))).toBe(true);
  });
});

describe("hitTestRect", () => {
  const lookup = lookupOf([
    ["a", 0, 0],
    ["b", 400, 0],
    ["c", 0, 400],
  ]);

  it("涂抹/框选语义：部分相交即命中（与 React Flow 自带框选一致）", () => {
    const rect = rectFromJourney({ x: -20, y: -20 }, { x: 60, y: 60 });
    expect(hitTestRect(rect, lookup)).toEqual(["a"]);
  });

  it("完全落入语义：要求节点整体在框内", () => {
    const tight = rectFromJourney({ x: -20, y: -20 }, { x: 60, y: 60 });
    expect(hitTestRect(tight, lookup, { fullyInside: true })).toEqual([]);
    const wide = rectFromJourney({ x: -20, y: -20 }, { x: 620, y: 540 });
    expect(new Set(hitTestRect(wide, lookup, { fullyInside: true }))).toEqual(
      new Set(["a", "b", "c"]),
    );
  });

  it("框到两个节点时两个都命中（相交语义）", () => {
    const rect = rectFromJourney({ x: -20, y: -20 }, { x: 640, y: 140 });
    expect(hitTestRect(rect, lookup)).toEqual(["a", "b"]);
  });

  it("零面积矩形（点选）命中包含该点的节点", () => {
    // 点在节点 a 内部
    expect(hitTestRect({ x: 10, y: 10, width: 0, height: 0 }, lookup)).toEqual(["a"]);
    // 点在节点 a 的边框上：面积算法会算成 0，必须靠矩形相交兜住
    expect(hitTestRect({ x: 0, y: 0, width: 0, height: 0 }, lookup)).toEqual(["a"]);
    // 点在空白处
    expect(hitTestRect({ x: 900, y: 900, width: 0, height: 0 }, lookup)).toEqual([]);
  });

  it("空白区域不命中任何节点", () => {
    const rect = rectFromJourney({ x: 900, y: 900 }, { x: 1000, y: 1000 });
    expect(hitTestRect(rect, lookup)).toEqual([]);
  });

  it("命中容差把贴着边界的点纳进来", () => {
    const justOutside = { x: 205, y: 60, width: 0, height: 0 };
    expect(hitTestRect(justOutside, lookup)).toEqual([]);
    expect(hitTestRect(justOutside, lookup, { pad: 8 })).toEqual(["a"]);
  });
});
