import { describe, expect, it } from "vitest";
import { nodeTypes } from "./nodes";
import { KNOWN_NODE_TYPES, droppedCount, normalizeCanvasDoc } from "./normalizeDoc";
import { serializeCanvas } from "./usePersistence";

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

  it(`已知类型都认（${KNOWN_NODE_TYPES.length} 种）`, () => {
    const nodes = KNOWN_NODE_TYPES.map((type, i) => node({ id: `k${i}`, type }));
    expect(normalizeCanvasDoc(doc({ nodes })).nodes).toHaveLength(KNOWN_NODE_TYPES.length);
  });

  it("⭐ `KNOWN_NODE_TYPES` 与 `nodeTypes` 注册表**一一对应**（G53.i：原来全仓无断言）", () => {
    /*
     * `normalizeDoc.ts` 的注释写着"与 `nodeTypes` 里注册的渲染组件一一对应" ——
     * 而此前**没有任何断言**盯着这层对应：往 KNOWN_NODE_TYPES 里加一种却没有组件，
     * 文档能存下来、渲染时炸；反过来组件有、白名单没有，文档会被默默丢掉。
     * 这一条把两侧**对表**（新增类型必须两处都改）。
     */
    const registered = Object.keys(nodeTypes).sort();
    expect([...KNOWN_NODE_TYPES].sort(), "白名单与注册的渲染组件对不上（两边都要改）").toEqual(registered);
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
    /*
     * ⚠️⚠️ 这条用例原来**整组都在用 `points` 写**（2026-10-16 修）。
     *
     * 而应用真正写出去的是 `from` / `to`（见 `src/canvas/markers.ts` 的 `Marker`）——
     * 于是这条"形状对不对"的用例与实现**自洽地一起错着**：
     * 真实形状的标记在它眼里是"形状不对"，而它自己编的 `points` 又永远见不到。
     * 代价在 `accept-p5` 里实测到了：**重启之后全部标记被丢掉，紧接着自动保存把空集合写回磁盘**。
     * 现在按**真实形状**写用例，并单独钉一条"写出去→读回来"的往返（见下面那条）。
     */
    const markers = [
      { id: "m1", kind: "rect", from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, color: "#f87171", width: 3 },
      { id: "m2", kind: "什么", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
      { id: "m3", kind: "rect", from: { x: 0, y: 0 }, to: null },
      { id: "m4", kind: "rect" },
      { kind: "rect", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
      /* 早期若写过 `points` 那种形状，内容不该丢（兼容，不是主路径） */
      { id: "m5", kind: "arrow", points: [{ x: 2, y: 2 }, { x: 9, y: 9 }] },
    ];
    const got = normalizeCanvasDoc(doc({ markers }));
    expect(got.markers.map((m) => m.id), "真实形状的留下；`points` 那条也要认得（兼容）").toEqual(["m1", "m5"]);
    expect(got.dropped.markers).toBe(4);
    const m1 = got.markers[0] as unknown as { from: { x: number }; to: { x: number } };
    expect([m1.from.x, m1.to.x], "点要原样留下（不是挪一下）").toEqual([0, 10]);
  });

  it("⭐ 往返：`serializeCanvas` 写出去的标记，`normalizeCanvasDoc` 必须原样认回来", () => {
    /*
     * ⭐ 这条是给"写与读各理解一套形状"这种毛病上的锁（2026-10-16，P28 同族）。
     * 它不引用任何一份手写的"期望形状" —— 直接拿**真写出去的东西**喂给读的那一端。
     * 谁改了 `Marker` 的形状而忘了改归一化，这条立刻红。
     */
    const written = serializeCanvas({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      revision: 3,
      confirmedRevision: 3,
      markers: [
        { id: "a", kind: "rect", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, color: "#f87171", width: 3 },
        {
          id: "b",
          kind: "scratch",
          from: { x: 5, y: 5 },
          to: { x: 6, y: 7 },
          trail: [{ x: 5, y: 5 }, { x: 5.5, y: 6 }],
          color: "#4ade80",
          width: 2,
        },
        { id: "c", kind: "text", from: { x: 8, y: 8 }, to: { x: 8, y: 8 }, text: "看这里", color: "#fbbf24", width: 2 },
      ] as never,
    });
    const got = normalizeCanvasDoc(written);
    expect(got.dropped.markers, "自己写出去的标记一条都不该被丢掉").toBe(0);
    expect(got.markers.map((m) => m.id)).toEqual(["a", "b", "c"]);
    const b = got.markers[1] as unknown as { trail: unknown[] };
    expect(b.trail.length, "涂鸦的轨迹也要留（否则那一笔会画成一条直线）").toBe(2);
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
