/**
 * **任务板**（L02，2026-10-18）。
 *
 * ## 它解决什么
 *
 * `runTeam` 是"派一次活、等结果"——一次性的。团队协作需要的是**可持续**的板子：
 * 任务有依赖（`blockedBy`，无环）、有状态（待领 / 已领 / 完成 / 失败）、
 * 有人领（`assignee`）、有版本（`revision` 做**乐观并发**）、还有**信箱**（互相留言）。
 *
 * ## 三条口径
 *
 * 1. **依赖无环**：加任务/改依赖时检查，成环直接拒绝（环会让"谁先做"永远不成立）；
 * 2. **CAS 认领**：认领要带**你看到的 revision**；不一致就是"别人先改了"，
 *    返回冲突而不是覆盖 —— 与数据库乐观锁同一个语义；
 * 3. **信箱按人隔离**：`inboxOf(member)` 只返回发给他的；`ack` 之后不再出现。
 *
 * ## 持久化
 *
 * 这个模块是**纯逻辑**（宿主把 board 存哪儿是宿主的事）——
 * 单测不需要磁盘，CLI/桌面各自决定落点。
 */

/** 任务状态。 */
export type TaskStatus = "open" | "claimed" | "done" | "failed";

/** 板上的一条任务。 */
export type BoardTask = {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  /** 谁领的。 */
  assignee?: string;
  /** 依赖的任务 id（全部 `done` 才能认领）。 */
  blockedBy: string[];
  /** 乐观并发版本：每次变更 +1。 */
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** 结果/失败原因（完成或失败时写）。 */
  note?: string;
};

/** 一条留言。 */
export type BoardMessage = {
  id: string;
  from: string;
  to: string;
  text: string;
  at: number;
  /** 已读（ack 之后不再出现在 inbox）。 */
  acked: boolean;
};

/** 整块板。 */
export type Board = {
  tasks: BoardTask[];
  messages: BoardMessage[];
  /** 板版本（每次变更 +1；界面据此判断要不要重拉）。 */
  revision: number;
};

/** 一次操作的结果。 */
export type BoardResult<T = Board> = { ok: true; board: T } | { ok: false; error: string };

/** 建一块空板。 */
export function createBoard(): Board {
  return { tasks: [], messages: [], revision: 0 };
}

/** 深拷贝一份（所有操作都不原地改输入：调用方可以放心持有旧版本）。 */
function clone(board: Board): Board {
  return {
    tasks: board.tasks.map((t) => ({ ...t, blockedBy: [...t.blockedBy] })),
    messages: board.messages.map((m) => ({ ...m })),
    revision: board.revision,
  };
}

/** 会不会成环：从 `start` 顺着 blockedBy 走，能回到 `start` 就是环。 */
export function wouldCycle(tasks: readonly BoardTask[], taskId: string, blockedBy: readonly string[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stack = [...blockedBy];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const dep = byId.get(id);
    if (dep) stack.push(...dep.blockedBy);
  }
  return false;
}

/**
 * 加一条任务。
 *
 * @param board 板
 * @param input 任务（`blockedBy` 必须指向存在的任务）
 * @param now 时间（测试用）
 */
export function addTask(
  board: Board,
  input: { id?: string; title: string; description?: string; blockedBy?: readonly string[]; now?: number },
): { ok: true; board: Board; task: BoardTask } | { ok: false; error: string } {
  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, error: "任务标题不能为空" };
  const now = input.now ?? Date.now();
  const id = input.id?.trim() || `t-${now.toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  if (board.tasks.some((t) => t.id === id)) return { ok: false, error: `任务 id 重复：${id}` };
  const blockedBy = [...new Set(input.blockedBy ?? [])];
  const missing = blockedBy.filter((dep) => !board.tasks.some((t) => t.id === dep));
  if (missing.length) return { ok: false, error: `依赖的任务不存在：${missing.join(" / ")}` };
  if (wouldCycle(board.tasks, id, blockedBy)) return { ok: false, error: `依赖成环：${id} 依赖 ${blockedBy.join(",")}` };

  const next = clone(board);
  const task: BoardTask = {
    id,
    title,
    ...(input.description ? { description: input.description } : {}),
    status: "open",
    blockedBy,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  next.tasks.push(task);
  next.revision += 1;
  return { ok: true, board: next, task };
}

/** 这条任务现在能不能被认领（依赖全 done）。 */
export function isClaimable(board: Board, taskId: string): { ok: true } | { ok: false; error: string } {
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: `没有这个任务：${taskId}` };
  if (task.status === "done") return { ok: false, error: "这条已经完成了" };
  if (task.status === "claimed") return { ok: false, error: `已经被 ${task.assignee ?? "别人"} 领了` };
  const pending = task.blockedBy.filter((dep) => board.tasks.find((t) => t.id === dep)?.status !== "done");
  if (pending.length) return { ok: false, error: `还等着这些任务完成：${pending.join(" / ")}` };
  return { ok: true };
}

/**
 * 认领（**CAS**：带上你看到的 revision）。
 *
 * @param board 板
 * @param input.taskId 任务
 * @param input.assignee 谁领
 * @param input.revision 你看到的版本
 * @param input.now 时间
 */
export function claimTask(
  board: Board,
  input: { taskId: string; assignee: string; revision: number; now?: number },
): BoardResult {
  const task = board.tasks.find((t) => t.id === input.taskId);
  if (!task) return { ok: false, error: `没有这个任务：${input.taskId}` };
  if (task.revision !== input.revision) {
    return { ok: false, error: `这条任务已经变了（你看到 v${input.revision}，现在是 v${task.revision}）—— 刷新后再试` };
  }
  const claimable = isClaimable(board, input.taskId);
  if (!claimable.ok) return { ok: false, error: claimable.error };
  const assignee = String(input.assignee ?? "").trim();
  if (!assignee) return { ok: false, error: "认领人不能为空" };

  const next = clone(board);
  const target = next.tasks.find((t) => t.id === input.taskId)!;
  target.status = "claimed";
  target.assignee = assignee;
  target.revision += 1;
  target.updatedAt = input.now ?? Date.now();
  next.revision += 1;
  return { ok: true, board: next };
}

/**
 * 收尾一条任务（done / failed）。
 *
 * @param board 板
 * @param input.taskId 任务
 * @param input.status 终态
 * @param input.note 结果或失败原因
 * @param input.by 操作人（给了就校验是不是认领人）
 * @param input.now 时间
 */
export function finishTask(
  board: Board,
  input: { taskId: string; status: "done" | "failed"; note?: string; by?: string; now?: number },
): BoardResult {
  const task = board.tasks.find((t) => t.id === input.taskId);
  if (!task) return { ok: false, error: `没有这个任务：${input.taskId}` };
  if (task.status === "done" || task.status === "failed") return { ok: false, error: `这条已经收尾了（${task.status}）` };
  if (input.by && task.assignee && task.assignee !== input.by) {
    return { ok: false, error: `这条是 ${task.assignee} 领的，${input.by} 不能替它收尾` };
  }
  const next = clone(board);
  const target = next.tasks.find((t) => t.id === input.taskId)!;
  target.status = input.status;
  target.revision += 1;
  target.updatedAt = input.now ?? Date.now();
  if (input.note) target.note = input.note;
  next.revision += 1;
  return { ok: true, board: next };
}

/**
 * 留一句言。
 *
 * @param board 板
 * @param input.from 谁
 * @param input.to 给谁
 * @param input.text 内容
 * @param input.now 时间
 */
export function postMessage(
  board: Board,
  input: { from: string; to: string; text: string; now?: number },
): BoardResult {
  const text = String(input.text ?? "").trim();
  if (!input.from?.trim() || !input.to?.trim()) return { ok: false, error: "收发双方都要有名字" };
  if (!text) return { ok: false, error: "留言不能为空" };
  const now = input.now ?? Date.now();
  const next = clone(board);
  next.messages.push({
    id: `m-${now.toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    from: input.from.trim(),
    to: input.to.trim(),
    text,
    at: now,
    acked: false,
  });
  next.revision += 1;
  return { ok: true, board: next };
}

/** 某人的收件箱（未读，按时间升序）。 */
export function inboxOf(board: Board, member: string): BoardMessage[] {
  return board.messages.filter((m) => m.to === member && !m.acked);
}

/**
 * 把某些留言标成已读。
 *
 * @param board 板
 * @param member 谁在读（只能 ack 发给自己的）
 * @param ids 留言 id（省略 = 全部已读）
 */
export function ackMessages(board: Board, member: string, ids?: readonly string[]): BoardResult {
  const next = clone(board);
  let changed = 0;
  for (const message of next.messages) {
    if (message.to !== member || message.acked) continue;
    if (ids && !ids.includes(message.id)) continue;
    message.acked = true;
    changed += 1;
  }
  if (!changed) return { ok: false, error: "没有可标记的留言（是不是已经读过了？）" };
  next.revision += 1;
  return { ok: true, board: next };
}

/** 看板摘要（按状态计数 + 可认领的）。 */
export function boardSummary(board: Board): { open: number; claimed: number; done: number; failed: number; claimable: string[] } {
  const by = (status: TaskStatus) => board.tasks.filter((t) => t.status === status).length;
  return {
    open: by("open"),
    claimed: by("claimed"),
    done: by("done"),
    failed: by("failed"),
    claimable: board.tasks.filter((t) => isClaimable(board, t.id).ok).map((t) => t.id),
  };
}
