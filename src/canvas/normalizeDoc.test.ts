import { describe, expect, it } from "vitest";
import { KNOWN_NODE_TYPES, droppedCount, normalizeCanvasDoc } from "./normalizeDoc";

/**
 * 洗画布文档（§181）。
 *
 * 重点不在"洗得干净"，而在**取舍对不对**：
 * - 位置坏了 → **挪到原点，保住内容**（内容比布局重要）
 * - 类型不认识 → 丢掉（没有对应的渲染组件，留着必炸）
 * - 连线悬空 → 丢掉（react-flow 会因为它报错）
 */
const doc = (patch: Record<string, unknown> = {}) => ({
  version: 2,
  revision: 7,
  confirmedRevision: 7,
  updatedAt: "2026-10-13T00:00:00.000Z",
  viewport: { x: 12, y: -8, zoom: 1.5 },
  nodes: [],
  edges: [],
  markers: [],
  ...patch,
});

const node = (patch: Record<string, unknown> = {}) => ({
  id: "n1",
  type: "markdown",
  position: { x: 100, y: 200 },
  data: { text: "内容", title: "文本" },
  ...patch,
});

describe("洗画布文档（§181）", () => {
  it("正常的文档原样活着", () => {
    const got = normalizeCanvasDoc(doc({ nodes: [node()] }));
    expect(got.nodes).toHaveLength(1);
    expect(got.nodes[0]?.position).toEqual({ x: 100, y: 200 });
    expect(got.viewport).toEqual({ x: 12, y: -8, zoom: 1.5 });
    expect(got.revision).toBe(7);
    expect(droppedCount(got)).toBe(0);
  });

  it("⭐ 缺 `position` → **挪到原点，保住内容**（位置是布局，内容是用户的活）", () => {
    const got = normalizeCanvasDoc(doc({ nodes: [node({ position: undefined })] }));
    expect(got.nodes).toHaveLength(1);
    expect(got.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect((got.nodes[0]?.data as { text?: string })?.text).toBe("内容");
    expect(got.dropped.nodes).toBe(0);
  });

  it("position 里是字符串 / NaN 也当坏的（react-flow 只认有限数）", () => {
    const got = normalizeCanvasDoc(doc({ nodes: [node({ position: { x: "左", y: NaN } })] }));
    expect(got.nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it("⭐ 类型不认识 → 丢掉（没有对应的渲染组件，留着必炸）", () => {
    const got = normalizeCanvasDoc(doc({ nodes: [node({ type: "什么节点" }), node({ id: "n2", type: undefined })] }));
    expect(got.nodes).toEqual([]);
    expect(got.dropped.nodes).toBe(2);
  });

  it(`十种已知类型都认（${KNOWN_NODE_TYPES.length} 种）`, () => {
    const nodes = KNOWN_NODE_TYPES.map((type, i) => node({ id: `k${i}`, type }));
    expect(normalizeCanvasDoc(doc({ nodes })).nodes).toHaveLength(KNOWN_NODE_TYPES.length);
  });

  it("缺 id / id 重复 → 丢掉", () => {
    const got = normalizeCanvasDoc(doc({ nodes: [node({ id: undefined }), node(), node({ type: "code" })] }));
    expect(got.nodes).toHaveLength(1);
  });

  it("data 不是对象 → 给一个空对象（渲染组件读到 undefined 就不显示，但不炸）", () => {
    const got = normalizeCanvasDoc(doc({ nodes: [node({ data: "不是对象" })] }));
    expect(got.nodes[0]?.data).toEqual({});
  });

  it("⭐ 悬空连线丢掉（react-flow 会因为两端对不上报错）", () => {
    const nodes = [node({ id: "a" }), node({ id: "b" })];
    const edges = [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "a", target: "不在画布上" },
      { id: "e3", source: "a" },
      { source: "a", target: "b" },
    ];
    const got = normalizeCanvasDoc(doc({ nodes, edges }));
    expect(got.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(got.dropped.edges).toBe(3);
  });

  it("⭐ 被丢掉的节点**连在它身上的连线也一起丢**（否则就变成悬空连线了）", () => {
    const got = normalizeCanvasDoc(
      doc({
        nodes: [node({ id: "a" }), node({ id: "bad", type: "什么" })],
        edges: [{ id: "e1", source: "a", target: "bad" }],
      }),
    );
    expect(got.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(got.edges).toEqual([]);
  });

  it("标注：形状不对的丢掉，好的留着", () => {
    const markers = [
      { id: "m1", kind: "rect", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
      { id: "m2", kind: "什么", points: [{ x: 0, y: 0 }] },
      { id: "m3", kind: "rect", points: [] },
      { id: "m4", kind: "rect" },
      { kind: "rect", points: [{ x: 0, y: 0 }] },
    ];
    const got = normalizeCanvasDoc(doc({ markers }));
    expect(got.markers.map((m) => m.id)).toEqual(["m1"]);
    expect(got.dropped.markers).toBe(4);
  });

  it("viewport / revision 坏了给默认值（视图位置不该影响内容）", () => {
    const got = normalizeCanvasDoc(doc({ viewport: { x: "左", y: null, zoom: 0 }, revision: -3 }));
    expect(got.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(got.revision).toBe(0);
  });

  it("整个文件不是文档 → 空画布（坏文件不许把画布卡住）", () => {
    for (const bad of [null, undefined, 42, "{}", []]) {
      const got = normalizeCanvasDoc(bad);
      expect(got.nodes).toEqual([]);
      expect(got.revision).toBe(0);
    }
  });

  it("droppedCount 把三类加起来", () => {
    const got = normalizeCanvasDoc(
      doc({
        nodes: [node(), { id: "x", type: "什么" }],
        edges: [{ id: "e", source: "n1", target: "不在" }],
        markers: [{ id: "m", kind: "rect", points: [] }],
      }),
    );
    expect(got.dropped).toEqual({ nodes: 1, edges: 1, markers: 1 });
    expect(droppedCount(got)).toBe(3);
  });

  it("洗两遍结果一样（幂等 —— 否则每次加载都在漂移）", () => {
    const once = normalizeCanvasDoc(
      doc({ nodes: [node(), node({ id: "p", position: undefined }), { id: "y", type: "什么" }] }),
    );
    const twice = normalizeCanvasDoc(once);
    expect(twice.nodes).toEqual(once.nodes);
    expect(droppedCount(twice)).toBe(0);
  });
});
