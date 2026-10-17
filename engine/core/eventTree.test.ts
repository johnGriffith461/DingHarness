import { describe, expect, it } from "vitest";

import { buildSessionTree, pathTo, siblingsOf, treeLines, type SessionNodeInput } from "./eventTree";

/**
 * 会话事件树（L01）。
 *
 * 判据：分叉关系拼得对、坏数据不当回事、环不死循环、被标出来的节点仍然可见。
 */

const s = (sessionId: string, forkedFrom?: string, updatedAt = 1): SessionNodeInput => ({
  sessionId,
  ...(forkedFrom ? { forkedFrom } : {}),
  title: sessionId,
  updatedAt,
});

describe("建树（buildSessionTree）", () => {
  it("⭐ 一个根 + 两条分支", () => {
    const tree = buildSessionTree([s("root", undefined, 3), s("a", "root", 2), s("b", "root", 1)]);
    expect(tree.roots.map((r) => r.sessionId)).toEqual(["root"]);
    expect(tree.roots[0]?.children.map((c) => c.sessionId).sort()).toEqual(["a", "b"]);
    expect(tree.byId.get("a")?.depth).toBe(1);
  });

  it("多层分叉（分支上再分叉）", () => {
    const tree = buildSessionTree([s("root"), s("a", "root"), s("a1", "a")]);
    expect(tree.byId.get("a1")?.depth).toBe(2);
    expect(pathTo(tree, "a1").map((n) => n.sessionId)).toEqual(["root", "a", "a1"]);
  });

  it("⭐ 父会话不在了 → 当根并标 orphan（不静默丢）", () => {
    const tree = buildSessionTree([s("a", "gone")]);
    expect(tree.roots.map((r) => r.sessionId)).toEqual(["a"]);
    expect(tree.roots[0]?.orphan).toBe(true);
    expect(treeLines(tree)[0]).toContain("来历不明");
  });

  it("⭐ 自己指自己不炸（标成环 + 当根）", () => {
    const tree = buildSessionTree([s("x", "x")]);
    expect(tree.cycles).toContain("x");
    expect(tree.roots.map((r) => r.sessionId)).toEqual(["x"]);
  });

  it("⭐ 两个节点互相指（环）不死循环，且两个都还看得见", () => {
    const tree = buildSessionTree([s("a", "b"), s("b", "a")]);
    expect(tree.byId.size).toBe(2);
    expect(tree.roots.length).toBeGreaterThanOrEqual(1);
    expect(tree.cycles.length).toBeGreaterThan(0);
    /* 关键：不挂起、不丢节点 */
    expect([...tree.byId.keys()].sort()).toEqual(["a", "b"]);
  });

  it("空输入给空树", () => {
    const tree = buildSessionTree([]);
    expect(tree.roots).toEqual([]);
    expect(tree.byId.size).toBe(0);
  });

  it("没有标题时用 sessionId 兜底", () => {
    const tree = buildSessionTree([{ sessionId: "only" }]);
    expect(tree.roots[0]?.title).toBe("only");
  });
});

describe("路径与兄弟", () => {
  const tree = buildSessionTree([s("root", undefined, 3), s("a", "root", 2), s("b", "root", 1)]);

  it("pathTo 从根到自己", () => {
    expect(pathTo(tree, "b").map((n) => n.sessionId)).toEqual(["root", "b"]);
  });

  it("目标不在树里给空数组（不抛）", () => {
    expect(pathTo(tree, "nope")).toEqual([]);
  });

  it("⭐ siblingsOf 给出另一条分支（切分支用）", () => {
    expect(siblingsOf(tree, "a").map((n) => n.sessionId)).toEqual(["b"]);
    /* 根的兄弟是其它根 */
    expect(siblingsOf(tree, "root")).toEqual([]);
  });
});

describe("展示（treeLines）", () => {
  it("⭐ 缩进能看出层级，并标出当前会话", () => {
    const tree = buildSessionTree([s("root", undefined, 3), s("a", "root", 2), s("b", "root", 1)]);
    const lines = treeLines(tree, { mark: "b" });
    expect(lines[0]).toContain("root");
    expect(lines.some((l) => l.includes("├─") || l.includes("└─"))).toBe(true);
    expect(lines.some((l) => l.includes("← 当前"))).toBe(true);
  });
});
