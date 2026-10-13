import { describe, expect, it } from "vitest";
import { NODE_ID_PATTERN, nextNodeId } from "./types";

describe("nextNodeId", () => {
  it("在示例节点之后接着编号，不撞已有 id", () => {
    const nodes = [{ id: "n1" }, { id: "n2" }, { id: "n3" }];
    expect(nextNodeId(nodes)).toBe("n4");
    expect(nodes.some((n) => n.id === nextNodeId(nodes))).toBe(false);
  });

  it("空画布从 n1 开始", () => {
    expect(nextNodeId([])).toBe("n1");
  });

  it("取的是最大编号而不是数量（删掉中间节点后不复用 id）", () => {
    const nodes = [{ id: "n1" }, { id: "n4" }];
    expect(nextNodeId(nodes)).toBe("n5");
  });

  it("忽略前缀不同和其它形态的 id", () => {
    const nodes = [{ id: "n2" }, { id: "shape9" }, { id: "note" }, { id: "n_3" }, { id: "n" }];
    expect(nextNodeId(nodes)).toBe("n3");
  });

  it("id 形态识别：前缀 + 数字", () => {
    expect(NODE_ID_PATTERN.exec("n12")?.slice(1)).toEqual(["n", "12"]);
    expect(NODE_ID_PATTERN.exec("code007")?.slice(1)).toEqual(["code", "007"]);
    expect(NODE_ID_PATTERN.test("n1a")).toBe(false);
    expect(NODE_ID_PATTERN.test("n")).toBe(false);
  });
});
