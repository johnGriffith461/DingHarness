import { describe, expect, it } from "vitest";

import { fileChangesFrom, groupByPath, lineDiff, rollbackOf, summarizeChanges } from "./fileReview";

/**
 * 逐文件改动审阅（U08）。
 *
 * 挡三件事：
 * ① 从日志还原的改动清单**不编**：没成功的、被拦下的、非写类工具都不算；
 * ② 回滚动作是**可证明的**（edit 反向替换 / 新建才可删），覆盖写如实拒绝；
 * ③ diff 只表达"哪几行变了"，不修改任何东西。
 */

const call = (id: string, name: string, input: unknown) => ({ type: "tool-call", toolCallId: id, toolName: name, input });
const result = (id: string, name: string, output: unknown) => ({ type: "tool-result", toolCallId: id, toolName: name, output });

describe("从日志还原改动（fileChangesFrom）", () => {
  it("⭐ 编辑与新建都还原出来；覆盖写标记为不可回滚", () => {
    const changes = fileChangesFrom([
      call("c1", "edit_file", { path: "a.ts", oldText: "x = 1", newText: "x = 2" }),
      result("c1", "edit_file", { ok: true, line: "改了「a.ts」（替换 1 处）" }),
      call("c2", "write_file", { path: "b.md", content: "hello" }),
      result("c2", "write_file", { ok: true, created: true, line: "写了「b.md」" }),
      call("c3", "write_file", { path: "c.md", content: "new" }),
      result("c3", "write_file", { ok: true, created: false, line: "覆盖了「c.md」" }),
    ]);
    expect(changes).toHaveLength(3);
    expect(changes[0]).toMatchObject({ tool: "edit_file", path: "a.ts", before: "x = 1", after: "x = 2", reversible: true });
    expect(changes[1]).toMatchObject({ tool: "write_file", path: "b.md", reversible: true });
    expect(changes[2]).toMatchObject({ tool: "write_file", path: "c.md", reversible: false });
    expect(changes[2]?.why).toContain("没有留下原件");
  });

  it("失败的、被拦下的、只读的都不算改动", () => {
    const changes = fileChangesFrom([
      call("c1", "write_file", { path: "a", content: "x" }),
      { type: "tool-result", toolCallId: "c1", toolName: "write_file", error: "写不进去" },
      call("c2", "write_file", { path: "b", content: "x" }),
      result("c2", "write_file", { ok: true, pending: true }),
      call("c3", "read_file", { path: "c" }),
      result("c3", "read_file", { ok: true, text: "x" }),
    ]);
    expect(changes).toEqual([]);
  });

  it("按路径汇总：同一个文件的多次改动归一组（先出现的前）", () => {
    const changes = fileChangesFrom([
      call("c1", "edit_file", { path: "a.ts", oldText: "1", newText: "2" }),
      result("c1", "edit_file", { ok: true }),
      call("c2", "edit_file", { path: "b.ts", oldText: "1", newText: "2" }),
      result("c2", "edit_file", { ok: true }),
      call("c3", "edit_file", { path: "a.ts", oldText: "2", newText: "3" }),
      result("c3", "edit_file", { ok: true }),
    ]);
    const groups = groupByPath(changes);
    expect(groups.map((g) => g.path)).toEqual(["a.ts", "b.ts"]);
    expect(groups[0]?.changes).toHaveLength(2);
  });

  it("统计口径", () => {
    const changes = fileChangesFrom([
      call("c1", "edit_file", { path: "a", oldText: "1", newText: "2" }),
      result("c1", "edit_file", { ok: true }),
      call("c2", "write_file", { path: "b", content: "x" }),
      result("c2", "write_file", { ok: true, created: true }),
      call("c3", "write_file", { path: "c", content: "x" }),
      result("c3", "write_file", { ok: true, created: false }),
    ]);
    expect(summarizeChanges(changes)).toEqual({ files: 3, edits: 1, writes: 2, reversible: 2 });
  });
});

describe("回滚动作（rollbackOf）", () => {
  it("⭐ 编辑：新文换回原文", () => {
    const action = rollbackOf({
      toolCallId: "c1",
      tool: "edit_file",
      path: "a.ts",
      line: "",
      before: "old",
      after: "new",
      reversible: true,
    });
    expect(action).toEqual({ kind: "edit", path: "a.ts", oldText: "new", newText: "old" });
  });

  it("⭐ 新建：删除文件", () => {
    expect(
      rollbackOf({ toolCallId: "c", tool: "write_file", path: "b.md", line: "", after: "x", reversible: true }),
    ).toEqual({ kind: "delete", path: "b.md" });
  });

  it("⭐ 覆盖写：如实拒绝（不猜旧内容）", () => {
    const action = rollbackOf({
      toolCallId: "c",
      tool: "write_file",
      path: "c.md",
      line: "",
      after: "x",
      reversible: false,
      why: "覆盖写没有原件",
    });
    expect(action.kind).toBe("impossible");
    if (action.kind === "impossible") expect(action.why).toContain("没有原件");
  });
});

describe("逐行 diff（lineDiff）", () => {
  it("能看出改了哪一行", () => {
    const got = lineDiff("a\nb\nc", "a\nB\nc");
    expect(got).toEqual([
      { kind: " ", text: "a" },
      { kind: "-", text: "b" },
      { kind: "+", text: "B" },
      { kind: " ", text: "c" },
    ]);
  });

  it("纯新增 / 纯删除", () => {
    expect(lineDiff("", "a\nb")).toEqual([
      { kind: "+", text: "a" },
      { kind: "+", text: "b" },
    ]);
    expect(lineDiff("a\nb", "")).toEqual([
      { kind: "-", text: "a" },
      { kind: "-", text: "b" },
    ]);
  });

  it("超过上限时收尾一条省略行（不把几百行全吐出来）", () => {
    const before = Array.from({ length: 30 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 30 }, (_, i) => `new ${i}`).join("\n");
    const got = lineDiff(before, after, { maxLines: 10 });
    expect(got).toHaveLength(11);
    expect(got.at(-1)?.text).toContain("还有");
  });
});
