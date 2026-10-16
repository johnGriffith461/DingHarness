import { describe, expect, it } from "vitest";
import { isPersistableChange, serializeCanvas, validateRevision } from "./usePersistence";
import type { CanvasNode } from "./types";
import { makeMarkdownNode } from "./types";

const node = makeMarkdownNode("n1", { x: 10, y: 20 }, "内容", { width: 300, height: 200 }, "标题");

/**
 * ⭐ P30：视口（平移 / 缩放）从不被持久化。
 *
 * 修前实测：订阅侧只有 `if (state.revision === prev.revision) return;`，而 `setViewport`
 * 不推修订号 → "拖到别处再看"这一整类动作**永远不落盘**（`serializeCanvas` 却一直在写 `viewport`）。
 * 这一组把判据钉在纯函数上：**修订号没变、视口变了 → 必须落盘**。
 */
describe("isPersistableChange（P30）", () => {
  const at = (revision: number, x: number, y: number, zoom: number) => ({
    revision,
    viewport: { x, y, zoom },
  });

  it("⭐ 修订号没变但视口动了 → 要落盘（原来这一支被直接 return 掉了）", () => {
    expect(isPersistableChange(at(3, -120, 40, 1.25), at(3, 0, 0, 1))).toBe(true);
  });

  it("缩放变了也算（缩放同样只走 setViewport）", () => {
    expect(isPersistableChange(at(7, 0, 0, 2), at(7, 0, 0, 1))).toBe(true);
  });

  it("修订号前进 → 要落盘（内容那条路不能被这次改动弄丢）", () => {
    expect(isPersistableChange(at(4, 0, 0, 1), at(3, 0, 0, 1))).toBe(true);
  });

  it("什么都没变 → 不落盘（手势结束回到原处不该白写一次）", () => {
    expect(isPersistableChange(at(3, 12, -8, 1.5), at(3, 12, -8, 1.5))).toBe(false);
  });

  it("视口缺了也不崩（载入前的半截状态）：判成「不值得单独存」", () => {
    expect(
      isPersistableChange(
        { revision: 3, viewport: undefined as unknown as { x: number; y: number; zoom: number } },
        at(3, 0, 0, 1),
      ),
    ).toBe(false);
  });
});

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
    /*
     * ⚠️ 2026-10-16（审计 G53.v）：原来只断"是个长度 >10 的字符串" —— 任何字符串都过。
     * 现在要求它是**合法的 ISO 时间戳**，且落在最近（这份文档刚被写过）。
     */
    expect(typeof doc.updatedAt).toBe("string");
    const seen = new Date(String(doc.updatedAt));
    expect(Number.isNaN(seen.getTime()), `updatedAt 不是合法时间：${doc.updatedAt}`).toBe(false);
    expect(String(doc.updatedAt), "updatedAt 不是 ISO 形状").toBe(seen.toISOString());
    expect(Date.now() - seen.getTime(), "updatedAt 不是「刚刚」写的").toBeLessThan(60_000);
  });
});
