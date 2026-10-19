/**
 * P0-01：`todo_write` —— 模型维护一份**可见、抗压缩**的待办清单。
 *
 * 这里只做纯逻辑：校验 / 规整 / 回显。真正的状态来源是会话日志里的
 * `tool-result`（任务轨迹），宿主不需要为它新增事件类型 —— 压缩只影响
 * 发给模型的消息，不影响任务轨迹。
 */

import {
  TODO_CONTENT_LIMIT,
  TODO_MAX_ITEMS,
  TODO_STATUSES,
  TODO_WRITE_TOOL,
} from "../../../shared/agentTools";

/*
 * ⚠️ 名字 / 上限 / 状态词表**从契约层转出**：schema 在那里（模型看到的参数说明），
 * 这里只做运行时校验。两处各写一份的后果是"schema 说 30、执行体说 20"——
 * 模型照着说明写、被拒绝，然后开始瞎猜。
 */
export { TODO_CONTENT_LIMIT, TODO_MAX_ITEMS, TODO_WRITE_TOOL };

export type TodoStatus = (typeof TODO_STATUSES)[number];

export type TodoItem = { content: string; status: TodoStatus };

const STATUSES: readonly TodoStatus[] = TODO_STATUSES;

export type NormalizeTodosResult =
  | { ok: true; todos: TodoItem[] }
  | { ok: false; error: string };

/**
 * 校验并规整模型给的待办。
 *
 * 规则：
 * - 至少 1 条、最多 {@link TODO_MAX_ITEMS} 条；
 * - 内容去首尾空白，空项直接丢掉（不是失败 —— 模型偶尔会留一行空的）；
 * - 状态必须是四个值之一；
 * - 非并行模式：**只允许一个 `in_progress`**，后来的降为 `pending`
 *   （模型常见写法是把整份清单都标成进行中，那等于没有进度）。
 */
export function normalizeTodos(raw: unknown): NormalizeTodosResult {
  if (!Array.isArray(raw)) return { ok: false, error: "todos 必须是一个数组" };
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (!content) continue;
    if (content.length > TODO_CONTENT_LIMIT) {
      return { ok: false, error: `单条待办不能超过 ${TODO_CONTENT_LIMIT} 字` };
    }
    const status = o.status;
    if (typeof status !== "string" || !STATUSES.includes(status as TodoStatus)) {
      return { ok: false, error: `待办状态必须是 ${STATUSES.join(" / ")} 之一` };
    }
    items.push({ content, status: status as TodoStatus });
  }
  if (items.length === 0) return { ok: false, error: "至少要有 1 条待办（空内容不计）" };
  if (items.length > TODO_MAX_ITEMS) {
    return { ok: false, error: `待办最多 ${TODO_MAX_ITEMS} 条（现在是 ${items.length} 条）` };
  }
  let seenInProgress = false;
  const todos = items.map((item) => {
    if (item.status !== "in_progress") return item;
    if (seenInProgress) return { ...item, status: "pending" as const };
    seenInProgress = true;
    return item;
  });
  return { ok: true, todos };
}

/** 给模型/界面看的一行回显。 */
export function describeTodoResult(todos: readonly TodoItem[]): string {
  const count = (status: TodoStatus): number => todos.filter((t) => t.status === status).length;
  const parts = [
    `${count("in_progress")} 进行中`,
    `${count("completed")} 完成`,
    `${count("pending")} 待办`,
    `${count("blocked")} 受阻`,
  ];
  return `已更新待办：${todos.length} 项（${parts.join(" / ")}）`;
}

const MARKS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  blocked: "[!]",
};

/** 渲染成模型看的清单（不含外层标签）。 */
export function renderTodos(todos: readonly TodoItem[]): string {
  return todos.map((t) => `- ${MARKS[t.status]} ${t.content}`).join("\n");
}

/** 包成 `<todos>` 块的完整文本（给 system 用）。 */
export function renderTodosBody(todos: readonly TodoItem[]): string {
  return ["<todos>", "当前任务的待办（来自最近一次 todo_write）：", renderTodos(todos), "</todos>"].join("\n");
}
