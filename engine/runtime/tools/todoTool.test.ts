import { describe, expect, it } from "vitest";

import { describeTodoResult, normalizeTodos, TODO_MAX_ITEMS, renderTodos } from "./todoTool";

/**
 * P0-01：todo_write 的纯逻辑。
 *
 * 判据只有三条：坏的输入不落（空 / 超限 / 非法状态），
 * 非并行模式下**只有一个 in_progress**，回显计数与输入一致。
 */
describe("normalizeTodos", () => {
  it("拒绝空数组", () => {
    const got = normalizeTodos([]);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("至少");
  });

  it("拒绝非数组", () => {
    expect(normalizeTodos(undefined).ok).toBe(false);
    expect(normalizeTodos("todo").ok).toBe(false);
  });

  it(`超过 ${TODO_MAX_ITEMS} 条被拒`, () => {
    const tooMany = Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, i) => ({
      content: `第 ${i + 1} 项`,
      status: "pending" as const,
    }));
    const got = normalizeTodos(tooMany);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain(String(TODO_MAX_ITEMS));
  });

  it("去空白、丢掉空项", () => {
    const got = normalizeTodos([
      { content: "  读测试  ", status: "pending" },
      { content: "   ", status: "pending" },
      { content: "改实现", status: "in_progress" },
    ]);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.todos).toEqual([
        { content: "读测试", status: "pending" },
        { content: "改实现", status: "in_progress" },
      ]);
    }
  });

  it("两个 in_progress 被规整为一个（保留第一个，其余降为 pending）", () => {
    const got = normalizeTodos([
      { content: "A", status: "in_progress" },
      { content: "B", status: "in_progress" },
      { content: "C", status: "pending" },
    ]);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.todos.map((t) => t.status)).toEqual(["in_progress", "pending", "pending"]);
    }
  });

  it("非法状态被拒", () => {
    const got = normalizeTodos([{ content: "A", status: "doing" }]);
    expect(got.ok).toBe(false);
  });

  it("接受 blocked 状态", () => {
    const got = normalizeTodos([{ content: "等外部依赖", status: "blocked" }]);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.todos[0]?.status).toBe("blocked");
  });
});

describe("describeTodoResult / renderTodos", () => {
  const todos = [
    { content: "读测试", status: "completed" as const },
    { content: "改实现", status: "in_progress" as const },
    { content: "跑测试", status: "pending" as const },
    { content: "等评审", status: "blocked" as const },
  ];

  it("计数正确（进行中 / 完成 / 待办 / 受阻）", () => {
    const line = describeTodoResult(todos);
    expect(line).toContain("4 项");
    expect(line).toContain("1 进行中");
    expect(line).toContain("1 完成");
    expect(line).toContain("1 待办");
    expect(line).toContain("1 受阻");
  });

  it("渲染块带状态标记与内容", () => {
    const text = renderTodos(todos);
    expect(text).toContain("改实现");
    expect(text).toContain("读测试");
    expect(text).toContain("[~]");
    expect(text).toContain("[x]");
    expect(text).toContain("[!]");
  });
});
