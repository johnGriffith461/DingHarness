/**
 * P0-01：把任务轨迹里的待办投影成 system 里的 `<todos>` 块。
 *
 * ⚠️ 来源必须是**任务步骤**（`TaskStep.tools`），不是最近几条消息：
 * 压缩会把早期消息摘成摘要，但任务轨迹不动 —— 所以待办能穿过压缩与重启。
 */

import type { TodoItem, TodoStatus } from "@engine/runtime/tools/todoTool";
import { renderTodosBody } from "@engine/runtime/tools/todoTool";
import type { TaskStep } from "./task";

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed", "blocked"];

function todosOf(output: unknown): TodoItem[] {
  if (!output || typeof output !== "object") return [];
  const raw = (output as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const content = typeof o.content === "string" ? o.content.trim() : "";
    const status = o.status;
    if (!content || typeof status !== "string" || !STATUSES.includes(status as TodoStatus)) continue;
    out.push({ content, status: status as TodoStatus });
  }
  return out;
}

/**
 * 取**最后一条成功**的 `todo_write` 结果。
 *
 * 模型可能在一轮里更新多次、也可能失败一次后重试 —— 只认最新的成功结果。
 */
export function extractTodos(steps: readonly TaskStep[]): TodoItem[] {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const tools = steps[i]?.tools ?? [];
    for (let j = tools.length - 1; j >= 0; j -= 1) {
      const trace = tools[j];
      if (!trace || trace.name !== "todo_write" || trace.ok !== true) continue;
      const todos = todosOf(trace.output);
      if (todos.length) return todos;
    }
  }
  return [];
}

/** 渲染待办块；没有待办时返回空串（不制造空标签）。 */
export function renderTodosBlock(todos: readonly TodoItem[]): string {
  return todos.length ? renderTodosBody(todos) : "";
}

/** 一步到位：从任务步骤里取待办并渲染。 */
export function todosBlockFromSteps(steps: readonly TaskStep[]): string {
  return renderTodosBlock(extractTodos(steps));
}
