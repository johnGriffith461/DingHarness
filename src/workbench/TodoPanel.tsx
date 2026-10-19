import { extractTodos } from "./todoContext";
import type { TaskStep } from "./task";

/**
 * P0-01：任务内待办面板（只读）。
 *
 * 数据来源与注入给模型的是**同一份投影**（`extractTodos`）：最后一条成功的
 * `todo_write`。没有待办时整块不渲染 —— 不占位置、不出现空壳。
 */
export function TodoPanel({ steps }: { steps: readonly TaskStep[] }) {
  const todos = extractTodos(steps);
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <aside className="wb-todo" data-testid="wb-todo-panel" aria-label="待办清单">
      <div className="wb-todo-head">
        <span>待办</span>
        <em data-testid="wb-todo-count">
          {done}/{todos.length}
        </em>
      </div>
      <ol className="wb-todo-list">
        {todos.map((todo, i) => (
          <li
            key={`${i}-${todo.content}`}
            className={`wb-todo-item is-${todo.status}`}
            data-testid={`wb-todo-item-${i}`}
            data-status={todo.status}
          >
            <span className="wb-todo-mark" aria-hidden>
              {todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : todo.status === "blocked" ? "[!]" : "[ ]"}
            </span>
            <span className="wb-todo-text">{todo.content}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
