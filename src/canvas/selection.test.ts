import { describe, expect, it } from "vitest";
import type { InternalNode, Node } from "@xyflow/react";
import type { NodeLookup } from "@xyflow/system";
import { drawZ, pickPointTarget, clickHitTest, toggleSelection } from "./selection";

/**
 * ⭐ P249：多选点选走几何命中，**画框与压在下面的卡片被一并切换**，和 DOM 点选结果不一致。
 *
 * 修前实测：`multiSelectBefore` 把 `clickHitTest` 的整份结果交给 `toggleSelection` ——
 * 一次 Ctrl+点选会把命中的每一个都切换一遍：点框里的卡片得到 {卡片, 画框}，
 * 两张重叠的卡片两张一起进选中集；而不带修饰键的普通点选走 React Flow 的 DOM 命中，
 * 只选压在**最上面**的那一个。
 *
 * 这一组用例钉住两条口径：
 *   ① 只切**一个**，且是绘制层序最上面的那个（`internals.z` 优先、同 z 按文档次序）；
 *   ② 画框**本体点不到**（`pointer-events: none`）—— 只有指针真的压在它自己的元素上才算它。
 *
 * 判据都是**可算的关系**（哪张卡在最上面、点框里空白得到什么），不是"有没有某个字符串"。
 */

type Fixture = {
  id: string;
  type?: string;
  /** 世界坐标下的左上角与尺寸。 */
  rect: { x: number; y: number; width: number; height: number };
  /** React Flow 算好的绘制层序（不写按 0 算）。 */
  z?: number;
  /** 节点自己的 `zIndex`（只在 `internals.z` 缺失时才该被用到）。 */
  zIndex?: number;
  hidden?: boolean;
};

/**
 * 造一份 React Flow 内部节点表（形状照 `adoptUserNodes` 的产物：
 * `internals.positionAbsolute` 给绝对坐标、`internals.z` 给绘制层序、`measured` 给尺寸）。
 *
 * 用法与真表一致：**插入顺序 = 节点数组顺序**（`nodeLookup` 就是这么建起来的）。
 */
function lookupOf(nodes: Fixture[]): NodeLookup<InternalNode<Node>> {
  const map = new Map<string, InternalNode<Node>>();
  for (const n of nodes) {
    map.set(n.id, {
      id: n.id,
      type: n.type ?? "markdown",
      position: { x: n.rect.x, y: n.rect.y },
      measured: { width: n.rect.width, height: n.rect.height },
      ...(typeof n.zIndex === "number" ? { zIndex: n.zIndex } : {}),
      ...(n.hidden ? { hidden: true } : {}),
      internals: {
        positionAbsolute: { x: n.rect.x, y: n.rect.y },
        ...(typeof n.z === "number" ? { z: n.z } : {}),
      },
    } as unknown as InternalNode<Node>);
  }
  return map as unknown as NodeLookup<InternalNode<Node>>;
}

/** 一张 100×100 的卡片，左上角在 (0,0) —— 点 (50,50) 一定落在它里面。 */
const CARD = { x: 0, y: 0, width: 100, height: 100 };
/** 罩住上面那张卡片的画框（比卡片大一圈）。 */
const FRAME = { x: -40, y: -40, width: 300, height: 300 };
const INSIDE = { x: 50, y: 50 };

describe("pickPointTarget：只切最上面那一个（P249）", () => {
  it("⭐ 点画框里的卡片：只切卡片，画框不许跟着进选中集", () => {
    const lookup = lookupOf([
      { id: "frame", type: "frame", rect: FRAME, z: -1 },
      { id: "card", rect: CARD, z: 0 },
    ]);
    /* 两个都几何命中（画框罩着卡片）—— 这正是修前"两个一起切换"的输入 */
    expect(clickHitTest(INSIDE, lookup, 3).sort()).toEqual(["card", "frame"]);
    expect(pickPointTarget(INSIDE, lookup, { order: ["frame", "card"] })).toBe("card");
  });

  it("⭐ 两张重叠的卡片：取文档次序靠后那张（后渲染的盖在上面）", () => {
    const lookup = lookupOf([
      { id: "under", rect: CARD },
      { id: "over", rect: CARD },
    ]);
    expect(pickPointTarget(INSIDE, lookup, { order: ["under", "over"] })).toBe("over");
  });

  it("⭐ z 说了算：选中态被 React Flow 抬高（+1000）的那张在上面 —— 与 DOM 的层序一致", () => {
    const lookup = lookupOf([
      /* 文档里靠前、但被选中 → DOM 上它 z 更高，压在后面那张上面 */
      { id: "selected", rect: CARD, z: 1000 },
      { id: "behind", rect: CARD, z: 0 },
    ]);
    expect(pickPointTarget(INSIDE, lookup, { order: ["selected", "behind"] })).toBe("selected");
  });

  it("⭐ 点画框里的空白（那里没有卡片）：谁都不切 —— DOM 也点不到画框本体", () => {
    const lookup = lookupOf([{ id: "frame", type: "frame", rect: FRAME, z: -1 }]);
    expect(clickHitTest({ x: -20, y: -20 }, lookup, 3)).toEqual(["frame"]);
    expect(pickPointTarget({ x: -20, y: -20 }, lookup)).toBeNull();
  });

  it("指针真的压在一张卡片上时，画框照样不算命中（它是 -1 层）", () => {
    const lookup = lookupOf([
      { id: "frame", type: "frame", rect: FRAME, z: -1 },
      { id: "card", rect: CARD, z: 0 },
    ]);
    /* domId 给的是卡片（`elementFromPoint` 在框内空白处返回的是 pane，不会是画框） */
    expect(pickPointTarget(INSIDE, lookup, { order: ["frame", "card"], domId: "card" })).toBe("card");
  });

  it("画框自己的元素被 DOM 命中时（标题栏 / 手柄）它才是目标 —— 那一下 DOM 选的也是它", () => {
    const lookup = lookupOf([
      { id: "frame", type: "frame", rect: FRAME, z: -1 },
      { id: "card", rect: CARD, z: 0 },
    ]);
    /* 标题栏在框的上沿（y = -40），卡片够不到那里 */
    const onTitle = { x: 60, y: -38 };
    expect(pickPointTarget(onTitle, lookup, { order: ["frame", "card"], domId: "frame" })).toBe("frame");
  });

  it("没有命中就返回 null（调用方据此把这次事件交回 DOM，而不是自己吞掉）", () => {
    const lookup = lookupOf([{ id: "card", rect: CARD }]);
    expect(pickPointTarget({ x: 900, y: 900 }, lookup, { order: ["card"] })).toBeNull();
  });

  it("藏起来的节点不参与（`hidden` 与画布上看见的一致）", () => {
    const lookup = lookupOf([{ id: "card", rect: CARD, hidden: true }]);
    expect(pickPointTarget(INSIDE, lookup, { order: ["card"] })).toBeNull();
  });

  it("容差仍然在（默认 3px）：贴着边缘外 2px 也点得到，不会突然「点空」", () => {
    const lookup = lookupOf([{ id: "card", rect: CARD }]);
    expect(pickPointTarget({ x: -2, y: 50 }, lookup, { order: ["card"] })).toBe("card");
  });
});

describe("drawZ：绘制层序取哪两个数", () => {
  it("优先 React Flow 算好的 internals.z（它含画框下沉 / 子节点 +1 / 选中抬升）", () => {
    expect(drawZ({ zIndex: 0, internals: { z: -1 } })).toBe(-1);
    expect(drawZ({ zIndex: 5, internals: { z: 1 } })).toBe(1);
  });

  it("拿不到 internals.z 时退到节点自己的 zIndex，再没有就 0", () => {
    expect(drawZ({ zIndex: 3 })).toBe(3);
    expect(drawZ({})).toBe(0);
  });
});

describe("toggleSelection 仍按「有就删、没有就加」的语义", () => {
  it("给一个 id：加进去或摘出来", () => {
    expect(toggleSelection([], ["a"])).toEqual(["a"]);
    expect(toggleSelection(["a", "b"], ["a"])).toEqual(["b"]);
  });

  it("一个都没命中就原样返回（少成数组也不丢当前选择）", () => {
    const current = ["a"];
    expect(toggleSelection(current, [])).toBe(current);
  });
});
