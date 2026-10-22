import { describe, expect, it } from "vitest";

import { clearRefs, renderSnapshot, type AxNode } from "./browserSnapshot";

/**
 * B-02：ARIA 快照渲染（方案要求的六条判据）。
 *
 * 用固定夹具，不碰 CDP —— 渲染规则（顺序/属性/ref 前缀/name 截断/generic/空树）
 * 是纯逻辑，必须在这里被钉住；CDP 那一侧只负责"拿到节点"。
 */
const node = (over: Partial<AxNode> & { nodeId: string }): AxNode => ({ ...over });

const tree: AxNode[] = [
  node({ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "示例" }, childIds: ["2", "3"] }),
  node({ nodeId: "2", role: { value: "heading" }, name: { value: "标题" }, backendDOMNodeId: 42, properties: [{ name: "level", value: { value: 1 } }] }),
  node({ nodeId: "3", role: { value: "link" }, name: { value: "更多" }, backendDOMNodeId: 43 }),
];

describe("ARIA 快照", () => {
  it("渲染成 role + name + ref + 属性的树状文本", () => {
    const got = renderSnapshot(tree, new Map());
    expect(got.text).toContain("RootWebArea");
    expect(got.text).toContain('heading "标题" [ref=e1] [level=1]');
    expect(got.text).toContain('link "更多" [ref=e2]');
    expect(got.total).toBe(3);
  });

  it("⭐ 连续两次快照，同一元素 ref 不变（绑定 backendDOMNodeId）", () => {
    const registry = new Map<number, string>();
    const first = renderSnapshot(tree, registry);
    const second = renderSnapshot(tree, registry);
    expect(second.text).toBe(first.text);
  });

  it("页面局部刷新：消失的元素不影响别人的 ref", () => {
    const registry = new Map<number, string>();
    const first = renderSnapshot(tree, registry);
    const withoutHeading = tree.filter((n) => n.nodeId !== "2");
    const second = renderSnapshot(withoutHeading, registry);
    /* link 仍是 e2；heading 的 e1 不再出现 */
    expect(second.text).toContain("[ref=e2]");
    expect(second.text).not.toContain("[ref=e1]");
    expect(first.text).toContain("[ref=e1]");
  });

  it("导航后 clearRefs → 重新从 e1 编号", () => {
    const registry = new Map<number, string>();
    renderSnapshot(tree, registry);
    clearRefs(registry);
    const again = renderSnapshot(tree, registry);
    expect(again.text).toContain("[ref=e1]");
  });

  it("子 frame 用 f1 前缀", () => {
    const got = renderSnapshot(
      [node({ nodeId: "9", role: { value: "button" }, name: { value: "确定" }, backendDOMNodeId: 99 })],
      new Map(),
      { framePrefix: "f1" },
    );
    expect(got.text).toContain("[ref=f1e1]");
  });

  it("name 超长截断到 900 字", () => {
    const long = "字".repeat(1000);
    const got = renderSnapshot([node({ nodeId: "1", role: { value: "link" }, name: { value: long }, backendDOMNodeId: 1 })], new Map());
    expect(got.text).toContain("…");
    expect(got.text.length).toBeLessThan(1000);
  });

  it("generic 无名字无子节点 → 不渲染（纯容器噪音）", () => {
    const got = renderSnapshot([node({ nodeId: "1", role: { value: "generic" }, name: { value: "" } })], new Map());
    expect(got.text).toContain("没有可访问元素");
  });

  it("空树给一句人话", () => {
    expect(renderSnapshot([], new Map()).text).toContain("没有可访问元素");
  });

  it("超长文本截断并写明", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      node({ nodeId: `n${i}`, role: { value: "link" }, name: { value: `链接${i}-${"x".repeat(40)}` }, backendDOMNodeId: 1000 + i }),
    );
    const got = renderSnapshot(many, new Map(), { maxChars: 500 });
    expect(got.truncated).toBe(true);
    expect(got.text).toContain("已截断");
  });
});
