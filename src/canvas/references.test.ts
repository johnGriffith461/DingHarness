import { describe, expect, it } from "vitest";
import { makeCodeNode, makeMarkdownNode } from "./types";
import {
  expandReferences,
  findNodeByLabel,
  nodeLabel,
  parseReferences,
  referenceCandidates,
  referencesToPrompt,
} from "./references";

const nodes = [
  makeMarkdownNode("n1", { x: 0, y: 0 }, "正文", undefined, "使用说明"),
  makeCodeNode("n2", { x: 0, y: 0 }, "code", "ts"),
  makeMarkdownNode("n3", { x: 0, y: 0 }, "正文", undefined, "使用说明和它的补充说明"),
];

/** 「代码」与「代码2」同时存在，用来验证右边界规则。 */
const overlapping = [
  makeMarkdownNode("n1", { x: 0, y: 0 }, "x", undefined, "代码"),
  makeMarkdownNode("n2", { x: 0, y: 0 }, "x", undefined, "代码2"),
];

describe("nodeLabel", () => {
  it("有标题用标题", () => {
    expect(nodeLabel(nodes[0])).toBe("使用说明");
  });

  it("有默认标题的节点用默认标题（代码卡片自带「代码」）", () => {
    expect(nodeLabel(nodes[1])).toBe("代码");
  });

  it("连默认标题都没有时用「类型 + 编号」兜底", () => {
    const bare = { id: "n7", type: "code" as const, data: { code: "x", lang: "ts" } };
    expect(nodeLabel(bare as never)).toBe("代码7");
  });
});

describe("parseReferences", () => {
  it("认出 @标题", () => {
    const refs = parseReferences("请把 @使用说明 压缩成三行", nodes);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ nodeId: "n1", label: "使用说明", kind: "markdown", state: "ok" });
  });

  it("标题更长时优先命中更长的那个（最长前缀优先）", () => {
    const refs = parseReferences("看看 @使用说明和它的补充说明 有没有问题", nodes);
    expect(refs).toHaveLength(1);
    expect(refs[0].nodeId).toBe("n3");
    expect(refs[0].label).toBe("使用说明和它的补充说明");
  });

  it("一句话里可以有多枚引用", () => {
    const refs = parseReferences("@使用说明 和 @使用说明和它的补充说明 对比一下", nodes);
    expect(refs.map((r) => r.nodeId)).toEqual(["n1", "n3"]);
  });

  it("标题后面紧跟中文标点也能切干净", () => {
    const refs = parseReferences("@使用说明，压缩一下", nodes);
    expect(refs).toHaveLength(1);
    expect(refs[0].end).toBe("@使用说明".length);
  });

  it("对不上的 @ 不产出引用（不误伤普通 at）", () => {
    expect(parseReferences("邮箱 me@example.com", nodes)).toEqual([]);
    expect(parseReferences("@@@", nodes)).toEqual([]);
  });

  it("被引用节点已不存在时不算 ok 引用", () => {
    const refs = parseReferences("@使用说明", []);
    expect(refs).toEqual([]);
  });

  it("节点被删后引用仍保留、但标成 broken（不能无声消失）", () => {
    const refs = parseReferences("@使用说明 帮我改", [], nodes);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ nodeId: "n1", label: "使用说明", state: "broken" });
  });

  it("节点还在时 known 列表不会把状态错标成 broken", () => {
    const refs = parseReferences("@使用说明 帮我改", nodes, nodes);
    expect(refs[0].state).toBe("ok");
  });

  it("下标能用来做替换", () => {
    const text = "把 @使用说明 改短";
    const [ref] = parseReferences(text, nodes);
    expect(text.slice(ref.start, ref.end)).toBe("@使用说明");
  });
});

describe("referencesToPrompt", () => {
  it("把引用写成 id + 类型 + 标题", () => {
    const refs = parseReferences("@使用说明 与 @代码2", [
      ...nodes,
      makeMarkdownNode("n4", { x: 0, y: 0 }, "x", undefined, "代码2"),
    ]);
    const text = referencesToPrompt(refs);
    expect(text).toContain("节点 n1");
    expect(text).toContain("文本");
    expect(text).toContain("节点 n4");
    expect(text).toContain("代码2");
  });

  it("没有引用时返回空串（调用方据此跳过拼接）", () => {
    expect(referencesToPrompt([])).toBe("");
  });

  it("断链引用会显式标注", () => {
    const text = referencesToPrompt([
      { start: 0, end: 5, nodeId: "n9", label: "旧节点", kind: "markdown", state: "broken" },
    ]);
    expect(text).toContain("已不在画布上");
  });
});

describe("expandReferences", () => {
  it("把芯片展开成「标题(节点 id)」", () => {
    const text = "把 @使用说明 改短";
    const refs = parseReferences(text, nodes);
    expect(expandReferences(text, refs)).toBe("把 「使用说明」(节点 n1) 改短");
  });

  it("没有引用时原样返回", () => {
    expect(expandReferences("普通文本", [])).toBe("普通文本");
  });

  it("多枚引用按位置正确拼接", () => {
    const text = "@使用说明 + 然后 @使用说明和它的补充说明";
    const refs = parseReferences(text, nodes);
    expect(expandReferences(text, refs)).toBe(
      "「使用说明」(节点 n1) + 然后 「使用说明和它的补充说明」(节点 n3)",
    );
  });

  it("右边界：@代码2 命中「代码2」而不是「代码」", () => {
    const refs = parseReferences("@代码2 看一下", overlapping);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ nodeId: "n2", label: "代码2" });
  });

  it("右边界：@代码 后面跟标点时命中「代码」", () => {
    const refs = parseReferences("@代码，看一下", overlapping);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ nodeId: "n1", label: "代码" });
  });
});

describe("findNodeByLabel / referenceCandidates", () => {
  it("按标题精确定位", () => {
    expect(findNodeByLabel(nodes, "使用说明")?.id).toBe("n1");
    expect(findNodeByLabel(nodes, "不存在")).toBeNull();
  });

  it("候选列表按关键词过滤，最多 8 个", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeMarkdownNode(`n${i + 1}`, { x: 0, y: 0 }, "x", undefined, `标题${i + 1}`),
    );
    expect(referenceCandidates(many, "").length).toBe(8);
    expect(referenceCandidates(many, "标题1").length).toBe(8);
    expect(referenceCandidates(many, "标题19").map((n) => n.id)).toEqual(["n19"]);
  });
});
