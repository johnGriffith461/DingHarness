import { describe, expect, it } from "vitest";
import { CLIPBOARD_MARK, parseClipboard, planPaste, serializeClipboard } from "./clipboard";
import { makeCodeNode, makeMarkdownNode } from "./types";

const nodes = [
  makeMarkdownNode("n1", { x: 100, y: 50 }, "A", undefined, "甲"),
  makeMarkdownNode("n2", { x: 300, y: 90 }, "B", undefined, "乙"),
];
const edges = [
  { id: "e1", source: "n1", target: "n2" },
  { id: "e2", source: "n2", target: "n9" }, // 目标不在复制集内
];

describe("serializeClipboard", () => {
  it("只带上两端都在复制集内的连线", () => {
    const text = serializeClipboard(nodes, edges as never);
    const parsed = JSON.parse(text);
    expect(parsed.mark).toBe(CLIPBOARD_MARK);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges.map((e: { id: string }) => e.id)).toEqual(["e1"]);
  });

  it("无法序列化时抛出可读错误（对标原版那条提示）", () => {
    const dirty = {
      ...nodes[0],
      data: { ...nodes[0].data, boom: () => undefined, self: undefined },
    } as never;
    // 循环引用才是真的不可序列化
    (dirty as { data: Record<string, unknown> }).data.loop = dirty;
    expect(() => serializeClipboard([dirty], [])).toThrow(/无法序列化/);
  });
});

describe("parseClipboard", () => {
  it("认得自己的载荷", () => {
    const text = serializeClipboard(nodes, edges as never);
    const parsed = parseClipboard(text);
    expect(parsed?.nodes).toHaveLength(2);
  });

  it("别人的文本静默忽略（不报错）", () => {
    expect(parseClipboard("随便一段文字")).toBeNull();
    expect(parseClipboard("")).toBeNull();
    expect(parseClipboard("{不是 JSON")).toBeNull();
  });

  it("标记对但结构不对也不吃（防误吞）", () => {
    expect(parseClipboard(JSON.stringify({ mark: CLIPBOARD_MARK, nodes: "x" }))).toBeNull();
  });
});

describe("planPaste", () => {
  const text = serializeClipboard(nodes, edges as never);
  const payload = parseClipboard(text)!;

  it("重排 id，不与已有节点冲突", () => {
    const plan = planPaste(payload, nodes, { x: 0, y: 0 });
    expect(plan.created).toHaveLength(2);
    expect(plan.created).not.toContain("n1");
    expect(plan.created).not.toContain("n2");
  });

  it("粘贴体的外接框左上角落在锚点", () => {
    const plan = planPaste(payload, nodes, { x: 500, y: 700 });
    const minX = Math.min(...plan.nodes.map((n) => n.position.x));
    const minY = Math.min(...plan.nodes.map((n) => n.position.y));
    expect(minX).toBe(500);
    expect(minY).toBe(700);
    // 相对位置保持不变
    const deltas = plan.nodes.map((n) => n.position.x - minX);
    expect(deltas).toContain(0);
    expect(deltas).toContain(200);
  });

  it("连线被改指到新节点，且只保留内部连线", () => {
    const plan = planPaste(payload, nodes, { x: 0, y: 0 });
    expect(plan.edges).toHaveLength(1);
    expect(plan.created).toContain(plan.edges[0].source);
    expect(plan.created).toContain(plan.edges[0].target);
  });

  it("粘贴出来的节点默认选中（方便立刻拖走或再复制）", () => {
    const plan = planPaste(payload, nodes, { x: 0, y: 0 });
    expect(plan.nodes.every((n) => n.selected)).toBe(true);
  });

  it("空载荷返回空计划", () => {
    const plan = planPaste({ mark: CLIPBOARD_MARK, nodes: [], edges: [] }, nodes, { x: 1, y: 2 });
    expect(plan.created).toEqual([]);
  });

  it("内容不被改动（深拷贝语义，改粘贴体不影响原节点）", () => {
    const code = makeCodeNode("n5", { x: 0, y: 0 }, "let a = 1", "ts");
    const p = parseClipboard(serializeClipboard([code], []))!;
    const plan = planPaste(p, [], { x: 0, y: 0 });
    (plan.nodes[0].data as { code: string }).code = "改过了";
    expect(code.data.code).toBe("let a = 1");
  });
});
