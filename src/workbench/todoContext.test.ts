import { describe, expect, it } from "vitest";

import { extractTodos, renderTodosBlock, todosBlockFromSteps } from "./todoContext";
import type { TaskStep } from "./task";

/**
 * P0-01：待办投影必须**抗压缩**。
 *
 * 来源是任务轨迹（`TaskStep.tools`），不是最近消息 —— 所以中间塞 100 条
 * 无关消息、甚至模拟"压缩后只剩摘要"，待办仍然在。
 */
function step(id: string, role: "user" | "assistant", text: string, tools?: TaskStep["tools"]): TaskStep {
  return { id, role, text, at: 0, ...(tools ? { tools } : {}) };
}

function todoWrite(id: string, todos: Array<{ content: string; status: string }>): TaskStep["tools"] {
  return [
    {
      toolCallId: id,
      name: "todo_write",
      ok: true,
      line: "已更新待办",
      output: { todos, count: todos.length },
    },
  ];
}

describe("extractTodos", () => {
  it("从最后一条 todo_write 提取", () => {
    const steps = [
      step("s1", "user", "修失败测试"),
      step("s2", "assistant", "先看看", todoWrite("t1", [
        { content: "读测试", status: "in_progress" },
        { content: "改实现", status: "pending" },
      ])),
    ];
    expect(extractTodos(steps)).toEqual([
      { content: "读测试", status: "in_progress" },
      { content: "改实现", status: "pending" },
    ]);
  });

  it("后面更新过就取最新的那一份", () => {
    const steps = [
      step("s1", "assistant", "第一版", todoWrite("t1", [{ content: "A", status: "in_progress" }])),
      step("s2", "assistant", "第二版", todoWrite("t2", [{ content: "A", status: "completed" }])),
    ];
    expect(extractTodos(steps)).toEqual([{ content: "A", status: "completed" }]);
  });

  it("失败的 todo_write 不算数", () => {
    const steps = [
      step("s1", "assistant", "坏的", [
        { toolCallId: "t1", name: "todo_write", ok: false, line: "失败", error: "bad" },
      ]),
    ];
    expect(extractTodos(steps)).toEqual([]);
  });

  it("中间插入 100 条无关消息、模拟压缩后仍在", () => {
    const steps = [
      step("s1", "assistant", "列待办", todoWrite("t1", [
        { content: "读测试", status: "completed" },
        { content: "改实现", status: "in_progress" },
      ])),
      ...Array.from({ length: 100 }, (_, i) => step(`x${i}`, i % 2 ? "assistant" : "user", `无关消息 ${i}`)),
    ];
    expect(extractTodos(steps)).toHaveLength(2);
    expect(renderTodosBlock(extractTodos(steps))).toContain("改实现");
  });

  it("没有待办时返回空串（不产生空块）", () => {
    expect(todosBlockFromSteps([step("s1", "user", "你好")])).toBe("");
  });
});

describe("renderTodosBlock", () => {
  it("包在 <todos> 标签里并带状态", () => {
    const text = renderTodosBlock([
      { content: "读测试", status: "completed" },
      { content: "改实现", status: "in_progress" },
    ]);
    expect(text.startsWith("<todos>")).toBe(true);
    expect(text.trim().endsWith("</todos>")).toBe(true);
    expect(text).toContain("[x] 读测试");
    expect(text).toContain("[~] 改实现");
  });
});
