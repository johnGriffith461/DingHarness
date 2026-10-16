import { describe, expect, it } from "vitest";
import {
  MARKER_KINDS,
  dragLongEnough,
  instructionFromMarkers,
  makeMarker,
  markerHitsNodes,
  markerNeedsDrag,
  markerRect,
  markersAsPrompt,
  markersHitNodes,
  nextMarkerId,
  nextMarkerOrder,
  trailLongEnough,
} from "./markers";
import { arrowGeometry, ellipseAttrs, polylinePath, rectAttrs, smoothPath } from "./markerGeometry";

const style = { color: "#f87171", width: 3 };

describe("markerRect", () => {
  it("圈出拖拽的外接矩形（含线宽留边）", () => {
    const m = makeMarker("m1", "rect", { x: 100, y: 50 }, { x: 200, y: 150 }, style);
    const box = markerRect(m);
    expect(box.x).toBeLessThan(100);
    expect(box.x + box.width).toBeGreaterThan(200);
    expect(box.y).toBeLessThan(50);
    expect(box.y + box.height).toBeGreaterThan(150);
  });

  it("单击类标记（批注）也有可命中的外框", () => {
    const m = makeMarker("m2", "text", { x: 10, y: 10 }, { x: 10, y: 10 }, style, { text: "这里改一下" });
    const box = markerRect(m);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  it("涂鸦用轨迹算外框，而不是起止点", () => {
    const m = makeMarker("m3", "scratch", { x: 0, y: 0 }, { x: 0, y: 0 }, style, {
      trail: [
        { x: 0, y: 0 },
        { x: 300, y: 20 },
      ],
    });
    const box = markerRect(m);
    expect(box.x + box.width).toBeGreaterThan(300);
  });

  it("反向拖拽（右下往左上）也能算出正的宽高", () => {
    const m = makeMarker("m4", "rect", { x: 200, y: 200 }, { x: 100, y: 100 }, style);
    const box = markerRect(m);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBeLessThan(100);
  });
});

describe("markerHitsNodes", () => {
  const rects = new Map([
    ["n1", { x: 0, y: 0, width: 100, height: 100 }],
    ["n2", { x: 400, y: 0, width: 100, height: 100 }],
    ["n3", { x: 0, y: 400, width: 100, height: 100 }],
  ]);

  it("压住谁就命中谁", () => {
    const box = makeMarker("m1", "rect", { x: -10, y: -10 }, { x: 120, y: 120 }, style);
    expect(markerHitsNodes(box, rects)).toEqual(["n1"]);
  });

  it("框空处不命中任何节点", () => {
    const empty = makeMarker("m2", "rect", { x: 200, y: 200 }, { x: 250, y: 250 }, style);
    expect(markerHitsNodes(empty, rects)).toEqual([]);
  });

  it("大框可同时命中多个节点并去重", () => {
    const all = makeMarker("m3", "rect", { x: -20, y: -20 }, { x: 600, y: 600 }, style);
    expect(markersHitNodes([all, all], rects)).toEqual(["n1", "n2", "n3"]);
  });
});

describe("markersAsPrompt", () => {
  const rects = new Map([["n1", { x: 0, y: 0, width: 100, height: 100 }]]);

  it("把标记写成人在哪儿留了什么话", () => {
    const m = makeMarker("m1", "rect", { x: -5, y: -5 }, { x: 105, y: 105 }, style);
    const text = markersAsPrompt([m], rects, (id) => `节点${id}`);
    expect(text).toContain("方框");
    expect(text).toContain("节点n1");
  });

  it("批注的文字进提示词", () => {
    const m = makeMarker("m2", "text", { x: 10, y: 10 }, { x: 10, y: 10 }, style, { text: "这段要更短" });
    const text = markersAsPrompt([m], rects, (id) => id);
    expect(text).toContain("这段要更短");
  });

  it("序号标记给出编号语义", () => {
    const m = makeMarker("m3", "number", { x: 10, y: 10 }, { x: 10, y: 10 }, style, { order: 2 });
    const text = markersAsPrompt([m], rects, (id) => id);
    expect(text).toContain("第 2 个");
  });

  it("没有标记时返回空串（调用方据此跳过拼接）", () => {
    expect(markersAsPrompt([], rects, (id) => id)).toBe("");
  });
});

/*
 * 「标记当提示词」这一段的**真正入口**（2026-10-14 补）。
 *
 * 原来这件事只有一条 e2e 在守（`accept-p5-prompt.mjs`），而它读的是
 * `window.__lastAiPrompt` —— DEV 构建才有的探针，打包产物里没有，
 * 所以那条脚本**永远跑不了**：功能等于没人守。函数搬进纯模块后由这里钉住。
 */
describe("instructionFromMarkers", () => {
  const node = (id: string, x: number, y: number) => ({ id, position: { x, y }, width: 300, height: 200 });
  const rect = makeMarker("m1", "rect", { x: 10, y: 10 }, { x: 310, y: 210 }, style);

  it("开关打开且圈住了节点时：把标记写进要求里，并带上是哪个节点", () => {
    const out = instructionFromMarkers({ markers: [rect], nodes: [node("n1", 0, 0)] }, true, "按标记改", (id) => `${id}(文本)`);
    expect(out).toContain("按标记改");
    expect(out).toContain("【画布标记】");
    expect(out).toContain("n1(文本)");
  });

  it("开关关着 → 原样返回（不许偷偷改用户的要求）", () => {
    const out = instructionFromMarkers({ markers: [rect], nodes: [node("n1", 0, 0)] }, false, "按标记改");
    expect(out).toBe("按标记改");
  });

  it("画布上没有标记 → 原样返回（不拼一个空的「画布标记」段）", () => {
    const out = instructionFromMarkers({ markers: [], nodes: [node("n1", 0, 0)] }, true, "按标记改");
    expect(out).toBe("按标记改");
  });

  it("标记圈在空白处 → 也要进去（只说要处理哪里，不硬说命中谁）", () => {
    const far = makeMarker("m2", "rect", { x: 5000, y: 5000 }, { x: 5300, y: 5200 }, style);
    const out = instructionFromMarkers({ markers: [far], nodes: [node("n1", 0, 0)] }, true, "改这里");
    expect(out).toContain("【画布标记】");
    expect(out).not.toContain("n1(");
  });

  it("批注的文字逐字进要求（人写什么就送什么）", () => {
    const note = makeMarker("m3", "text", { x: 20, y: 20 }, { x: 20, y: 20 }, style, { text: "这块内容要压缩成三行" });
    const out = instructionFromMarkers({ markers: [note], nodes: [node("n1", 0, 0)] }, true, "改一下");
    expect(out).toContain("这块内容要压缩成三行");
  });
});

describe("id 与序号分配", () => {
  it("id 在已有基础上递增", () => {
    const a = makeMarker("m1", "rect", { x: 0, y: 0 }, { x: 1, y: 1 }, style);
    expect(nextMarkerId([a])).toBe("m2");
    expect(nextMarkerId([])).toBe("m1");
  });

  it("序号按已有的序号标记数量递增", () => {
    const one = makeMarker("m1", "number", { x: 0, y: 0 }, { x: 0, y: 0 }, style, { order: 1 });
    expect(nextMarkerOrder([one])).toBe(2);
    expect(nextMarkerOrder([])).toBe(1);
  });
});

describe("长度门槛", () => {
  it("太短的拖拽不算一条标记（避免点击留下垃圾）", () => {
    expect(dragLongEnough({ x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
    expect(dragLongEnough({ x: 0, y: 0 }, { x: 20, y: 0 })).toBe(true);
  });

  it("涂鸦按累计路径长度判断，而不是首尾直线", () => {
    const zigzag = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(trailLongEnough(zigzag, 30)).toBe(true);
    expect(trailLongEnough([{ x: 0, y: 0 }], 1)).toBe(false);
  });
});

describe("工具分派", () => {
  it("八种标记都能被 dsl 覆盖到", () => {
    expect(MARKER_KINDS).toHaveLength(8);
  });

  it("拖拽类标记需要拖动，单击类不需要（**八个 kind 逐个分类**）", () => {
    /*
     * ⚠️ 2026-10-16（审计 G53.k）：原来只挑了 4 个 kind 验 —— 而 `markerNeedsDrag`
     * 是**手写枚举**（`kind === "rect" || …`），新加一个 kind 会**静默落进"不需要拖"**那一档。
     * 现在把八个 kind 的归属**写在测试里**逐个核对：加第九种而不来这张表登记，这条立刻红。
     */
    const NEEDS_DRAG: Record<string, boolean> = {
      rect: true,
      ellipse: true,
      arrow: true,
      scratch: true,
      highlight: true,
      mask: true,
      text: false,
      number: false,
    };
    expect(Object.keys(NEEDS_DRAG).sort(), "MARKER_KINDS 与这张分类表对不上（新 kind 要登记）").toEqual(
      [...MARKER_KINDS].sort(),
    );
    for (const [kind, needsDrag] of Object.entries(NEEDS_DRAG)) {
      expect(markerNeedsDrag(kind as never), `markerNeedsDrag("${kind}") 的归属与表里不一致`).toBe(needsDrag);
    }
  });
});

describe("markerGeometry", () => {
  it("矩形归一化：反向拖拽也得到正的宽高", () => {
    expect(rectAttrs({ x: 100, y: 100 }, { x: 20, y: 40 })).toEqual({ x: 20, y: 40, width: 80, height: 60 });
  });

  it("椭圆圆心在外接框中心", () => {
    const e = ellipseAttrs({ x: 0, y: 0 }, { x: 100, y: 50 });
    expect(e).toEqual({ cx: 50, cy: 25, rx: 50, ry: 25 });
  });

  it("零面积椭圆不会退化成不可见（rx/ry 至少 1）", () => {
    const e = ellipseAttrs({ x: 5, y: 5 }, { x: 5, y: 5 });
    expect(e.rx).toBeGreaterThanOrEqual(1);
    expect(e.ry).toBeGreaterThanOrEqual(1);
  });

  it("箭头头部落在终点，并且往回缩进", () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 3);
    expect(g.line).toEqual({ x1: 0, y1: 0, x2: 100, y2: 0 });
    expect(g.head[1]).toEqual({ x: 100, y: 0 });
    expect(g.head[0].x).toBeLessThan(100);
    expect(g.head[2].x).toBeLessThan(100);
  });

  it("极短箭头不会让箭头头部长过线段本身", () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 4, y: 0 }, 8);
    expect(g.head[0].x).toBeGreaterThanOrEqual(0);
    expect(g.head[2].x).toBeGreaterThanOrEqual(0);
  });

  it("折线路径首尾准确", () => {
    const d = polylinePath([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
    ]);
    expect(d.startsWith("M 0 0")).toBe(true);
    expect(d.endsWith("L 20 0")).toBe(true);
  });

  it("单点涂鸦也画得出来（不会返回空 path）", () => {
    expect(polylinePath([{ x: 3, y: 4 }])).toContain("M 3 4");
  });

  it("点少时退化为折线（避免二次贝塞尔把图形画歪）", () => {
    expect(smoothPath([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBe(
      polylinePath([{ x: 0, y: 0 }, { x: 5, y: 5 }]),
    );
  });

  it("点多时用平滑路径且终点仍是最后一点", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 0 },
      { x: 30, y: 8 },
    ];
    const d = smoothPath(points);
    expect(d).toContain("Q");
    expect(d.endsWith("L 30 8")).toBe(true);
  });
});
