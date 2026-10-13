import { describe, expect, it } from "vitest";
import { serializeCanvas, validateRevision } from "./usePersistence";
import type { CanvasNode } from "./types";
import { makeMarkdownNode } from "./types";

const node = makeMarkdownNode("n1", { x: 10, y: 20 }, "内容", { width: 300, height: 200 }, "标题");

describe("validateRevision", () => {
  it("允许等于已落盘修订（重复保存同一版）", () => {
    expect(validateRevision(5, 5)).toEqual({ ok: true });
  });

  it("允许前进", () => {
    expect(validateRevision(6, 5)).toEqual({ ok: true });
  });

  it("拒绝倒退（防止旧快照覆盖新内容）", () => {
    const result = validateRevision(4, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("不能倒退");
  });

  it("拒绝非整数与负数", () => {
    expect(validateRevision(1.5, 0).ok).toBe(false);
    expect(validateRevision(-1, 0).ok).toBe(false);
    expect(validateRevision(Number.NaN, 0).ok).toBe(false);
  });
});

describe("serializeCanvas", () => {
  it("产出可 JSON 往返的文档（函数/DOM 引用会被丢掉）", () => {
    const dirty = {
      ...node,
      data: { ...node.data, onSomething: () => undefined },
    } as unknown as CanvasNode;
    const doc = serializeCanvas({
      nodes: [dirty],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
      viewport: { x: -12, y: 34, zoom: 1.5 },
      revision: 3,
      confirmedRevision: 3,
    });

    const roundTrip = JSON.parse(JSON.stringify(doc));
    expect(roundTrip.version).toBe(2);
    expect(roundTrip.revision).toBe(3);
    expect(roundTrip.viewport).toEqual({ x: -12, y: 34, zoom: 1.5 });
    expect(roundTrip.nodes).toHaveLength(1);
    expect(roundTrip.nodes[0].id).toBe("n1");
    expect(roundTrip.nodes[0].data.text).toBe("内容");
    // 函数不该被写进快照
    expect(roundTrip.nodes[0].data.onSomething).toBeUndefined();
  });

  it("标记层随文档一起存（否则重启后批注全丢）", () => {
    const markers = [
      { id: "m1", kind: "rect" as const, from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, color: "#f87171", width: 3 },
    ];
    const doc = serializeCanvas({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      revision: 1,
      confirmedRevision: 1,
      markers,
    });
    expect(doc.markers).toHaveLength(1);
    expect(doc.markers?.[0]).toMatchObject({ id: "m1", kind: "rect" });
  });

  it("没传标记时写出空数组而不是 undefined", () => {
    const doc = serializeCanvas({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      revision: 1,
      confirmedRevision: 1,
    });
    expect(doc.markers).toEqual([]);
  });

  it("视口是拷贝，后续改动不影响已序列化结果", () => {
    const viewport = { x: 0, y: 0, zoom: 1 };
    const doc = serializeCanvas({
      nodes: [],
      edges: [],
      viewport,
      revision: 1,
      confirmedRevision: 1,
    });
    viewport.zoom = 9;
    expect(doc.viewport.zoom).toBe(1);
  });

  it("带上写入时间，便于状态栏显示", () => {
    const doc = serializeCanvas({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      revision: 1,
      confirmedRevision: 1,
    });
    expect(typeof doc.updatedAt).toBe("string");
    expect(doc.updatedAt && doc.updatedAt.length > 10).toBe(true);
  });
});
