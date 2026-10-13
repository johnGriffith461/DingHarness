import { describe, expect, it } from "vitest";
import {
  applyOrder,
  canFlip,
  canReorder,
  canReplaceImage,
  flipState,
  flipTransform,
  isLocked,
  reorderLayers,
  toLayerRows,
} from "./layers";
import { makeImageNode, makeMarkdownNode } from "./types";

const ids = ["a", "b", "c", "d"]; // 从底到顶：a 在最下面

describe("reorderLayers", () => {
  it("置顶：挪到最后", () => {
    expect(reorderLayers(ids, "b", "front")).toEqual(["a", "c", "d", "b"]);
  });

  it("置底：挪到最前", () => {
    expect(reorderLayers(ids, "c", "back")).toEqual(["c", "a", "b", "d"]);
  });

  it("上移一层：与后面那个换位", () => {
    expect(reorderLayers(ids, "a", "forward")).toEqual(["b", "a", "c", "d"]);
  });

  it("下移一层：与前面那个换位", () => {
    expect(reorderLayers(ids, "c", "backward")).toEqual(["a", "c", "b", "d"]);
  });

  it("已经在顶还点置顶/上移：原样返回（不产生空变更）", () => {
    expect(reorderLayers(ids, "d", "front")).toEqual(ids);
    expect(reorderLayers(ids, "d", "forward")).toEqual(ids);
  });

  it("已经在底还点置底/下移：原样返回", () => {
    expect(reorderLayers(ids, "a", "back")).toEqual(ids);
    expect(reorderLayers(ids, "a", "backward")).toEqual(ids);
  });

  it("未知 id 不动（不抛错，也不悄悄挪别人）", () => {
    expect(reorderLayers(ids, "不存在", "front")).toEqual(ids);
  });

  it("不动原数组（纯函数）", () => {
    const copy = [...ids];
    reorderLayers(ids, "b", "front");
    expect(ids).toEqual(copy);
  });

  it("置顶再置底能回到正确的相对位置", () => {
    const a = reorderLayers(ids, "b", "front"); // a c d b
    const b = reorderLayers(a, "b", "back"); //   b a c d
    expect(b).toEqual(["b", "a", "c", "d"]);
  });
});

describe("canReorder", () => {
  it("头尾的置顶/置底要置灰", () => {
    expect(canReorder(ids, "d", "front")).toBe(false);
    expect(canReorder(ids, "a", "back")).toBe(false);
    expect(canReorder(ids, "b", "front")).toBe(true);
    expect(canReorder(ids, "b", "back")).toBe(true);
  });

  it("只剩两层时上下移都有意义", () => {
    expect(canReorder(["a", "b"], "a", "forward")).toBe(true);
    expect(canReorder(["a", "b"], "b", "backward")).toBe(true);
  });

  it("未知 id 一律不可用", () => {
    expect(canReorder(ids, "x", "front")).toBe(false);
  });
});

describe("toLayerRows", () => {
  it("面板从顶到底（数组倒序）", () => {
    const nodes = [
      makeMarkdownNode("n1", { x: 0, y: 0 }, "底"),
      makeMarkdownNode("n2", { x: 0, y: 0 }, "中"),
      makeMarkdownNode("n3", { x: 0, y: 0 }, "顶"),
    ];
    const rows = toLayerRows(nodes);
    expect(rows.map((r) => r.id)).toEqual(["n3", "n2", "n1"]);
    // order 仍然是"从底往上"的序号，方便与数组下标对齐
    expect(rows.map((r) => r.order)).toEqual([2, 1, 0]);
  });

  it("带出隐藏 / 锁定 / 选中状态", () => {
    const a = { ...makeMarkdownNode("n1", { x: 0, y: 0 }, "A"), hidden: true };
    const b = { ...makeMarkdownNode("n2", { x: 0, y: 0 }, "B"), selected: true, data: { locked: true } };
    const rows = toLayerRows([a, b] as never);
    expect(rows[0]).toMatchObject({ id: "n2", locked: true, selected: true, hidden: false });
    expect(rows[1]).toMatchObject({ id: "n1", hidden: true });
  });

  it("标题在这里就算好（面板拿不到节点对象，不能让它自己拼）", () => {
    const nodes = [
      makeMarkdownNode("n1", { x: 0, y: 0 }, "x", undefined, "使用说明"),
      makeMarkdownNode("n2", { x: 0, y: 0 }, "y", undefined, "配图"),
    ];
    const rows = toLayerRows(nodes as never);
    // 倒序：n2 在前
    expect(rows[0].label).toBe("配图");
    expect(rows[1].label).toBe("使用说明");
    expect(rows.every((r) => r.label.length > 0)).toBe(true);
  });
});

describe("isLocked", () => {
  it("读 data.locked", () => {
    expect(isLocked({ data: { locked: true } } as never)).toBe(true);
    expect(isLocked({ data: {} } as never)).toBe(false);
    expect(isLocked({ data: undefined } as never)).toBe(false);
  });
});

describe("flipState / flipTransform", () => {
  it("连点两次水平翻转回到原样（异或，不是叠加）", () => {
    const once = flipState({}, "horizontal");
    expect(once).toEqual({ flipX: true, flipY: false });
    const twice = flipState(once, "horizontal");
    expect(twice).toEqual({ flipX: false, flipY: false });
  });

  it("两个轴互不影响", () => {
    const a = flipState({}, "horizontal");
    const b = flipState(a, "vertical");
    expect(b).toEqual({ flipX: true, flipY: true });
  });

  it("没有翻转时不产出 transform（省得给元素加无意义的合成层）", () => {
    expect(flipTransform({})).toBeUndefined();
    expect(flipTransform({ flipX: false, flipY: false })).toBeUndefined();
  });

  it("有翻转时给出对应的 scale", () => {
    expect(flipTransform({ flipX: true })).toBe("scale(-1, 1)");
    expect(flipTransform({ flipY: true })).toBe("scale(1, -1)");
    expect(flipTransform({ flipX: true, flipY: true })).toBe("scale(-1, -1)");
  });
});

describe("能力判定", () => {
  it("只有有画面的类型能翻转", () => {
    expect(canFlip("image")).toBe(true);
    // 形状是两个节点类型，不是一个叫 shape 的类型 —— 漏掉它们会让翻转一直是灰的
    expect(canFlip("rect")).toBe(true);
    expect(canFlip("ellipse")).toBe(true);
    expect(canFlip("markdown")).toBe(false);
    expect(canFlip("code")).toBe(false);
    expect(canFlip("whiteboard")).toBe(false);
  });

  it("只有图片能替换图", () => {
    expect(canReplaceImage("image")).toBe(true);
    expect(canReplaceImage("rect")).toBe(false);
  });
});

describe("applyOrder", () => {
  const nodes = [
    makeMarkdownNode("n1", { x: 0, y: 0 }, "1"),
    makeImageNode("n2", { x: 0, y: 0 }, ""),
  ];

  it("按给定顺序重排节点数组", () => {
    expect(applyOrder(nodes, ["n2", "n1"]).map((n) => n.id)).toEqual(["n2", "n1"]);
  });

  it("长度不一致时原样返回（防止界面数据不一致时把画布弄乱）", () => {
    expect(applyOrder(nodes, ["n1"])).toEqual(nodes);
    expect(applyOrder(nodes, ["n1", "n2", "n9"])).toEqual(nodes);
  });

  it("有未知 id 时原样返回", () => {
    expect(applyOrder(nodes, ["n1", "n9"])).toEqual(nodes);
  });

  it("不丢节点、不改内容", () => {
    const out = applyOrder(nodes, ["n2", "n1"]);
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect((out[1].data as { text: string }).text).toBe("1");
  });
});
