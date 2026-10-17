import { fold } from "../core/events";

/**
 * **逐文件改动审阅**（U08，2026-10-18）。
 *
 * ## 它解决什么
 *
 * 在这之前，"agent 改了什么"只能从对话里那几行留痕看出来：
 * `⚙ 改文件：a.ts（替换 1 处）`。用户要判断"这一堆改动我认不认"，
 * 得自己打开每个文件对着看 —— 而任务里一次可能改了十个文件。
 *
 * 现在从会话日志还原出**一份逐文件的改动清单**：
 *
 * | 能力 | 依据 |
 * |---|---|
 * | 看到每个文件改了哪几段 | `edit_file` 的 `oldText`/`newText`（日志里有） |
 * | 看到新建文件写了什么 | `write_file` 的 `content`（日志里有） |
 * | **回滚** | `edit_file` 反向替换；`write_file` 只在"新建"时可删 |
 *
 * ## 一条诚实边界（写在这里，也写进 CLI 输出）
 *
 * `write_file` **覆盖**已有文件时，日志里只有新内容、没有旧内容 ——
 * 所以这一条**回滚不了**。我们不去猜旧内容（那是编数据），
 * 而是如实告诉用户"这个改动没有留下原件，回滚要去版本控制里找"。
 * 想让它可回滚，得在执行时先备份（那需要动宿主写路径，不在本轮范围）。
 */

/** 一次文件改动。 */
export type FileChange = {
  toolCallId: string;
  /** 哪个工具：写 / 改。 */
  tool: "write_file" | "edit_file";
  /** 目标路径（模型给的原样）。 */
  path: string;
  /** 改动的说明（来自工具结果那行）。 */
  line: string;
  /** 对 `edit_file`：被替换掉的原文（整段）。 */
  before?: string;
  /** 对 `edit_file`：替换后的新文；对 `write_file`：写入的正文。 */
  after?: string;
  /** 能不能回滚。 */
  reversible: boolean;
  /** 为什么不能回滚（`reversible=false` 时给）。 */
  why?: string;
};

/** 日志记录的**最小形状**（不 import events 的全部类型，便于单测）。 */
type RecordLike = {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
};

/**
 * 从会话记录里还原逐文件改动（按发生顺序）。
 *
 * ⚠️ 走 `fold` 投影，不自己扫 `tool-call` / `tool-result` 配对：
 * 那个配对与 `pending` 判定**只能有一份**（`src/projectionGuard.test.ts` 挡的就是第二份）。
 *
 * @param records 会话日志记录
 */
export function fileChangesFrom(records: readonly RecordLike[]): FileChange[] {
  const view = fold(records as never);
  const changes: FileChange[] = [];
  for (const trace of view.traces) {
    if (!trace.ok || trace.pending) continue;
    if (trace.name !== "write_file" && trace.name !== "edit_file") continue;
    const input = (trace.input ?? {}) as Record<string, unknown>;
    const output = (trace.output ?? {}) as Record<string, unknown>;
    const path = typeof input.path === "string" ? input.path : "";
    if (!path) continue;
    const line = trace.line;

    if (trace.name === "edit_file") {
      const before = typeof input.oldText === "string" ? input.oldText : "";
      const after = typeof input.newText === "string" ? input.newText : "";
      changes.push({ toolCallId: trace.toolCallId, tool: "edit_file", path, line, before, after, reversible: true });
      continue;
    }

    const created = output.created === true;
    changes.push({
      toolCallId: trace.toolCallId,
      tool: "write_file",
      path,
      line,
      after: typeof input.content === "string" ? input.content : "",
      reversible: created,
      ...(created ? {} : { why: "覆盖写：日志里只有新内容，没有留下原件（去版本控制里找旧版本）" }),
    });
  }
  return changes;
}

/** 一行 diff。 */
export type DiffLine = { kind: " " | "-" | "+"; text: string };

/**
 * 简化版逐行 diff（LCS）。
 *
 * 这里**不引 diff 库**：审阅只需要"看出哪几行变了"，而一个 LCS 就够；
 * 引第三方库会让这条只读路径多一个依赖，还要处理它的选项与边界。
 *
 * @param before 旧文本
 * @param after 新文本
 * @param opts.maxLines 最多输出多少行（超出用一条省略行收尾）
 */
export function lineDiff(before: string, after: string, opts: { maxLines?: number } = {}): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const n = a.length;
  const m = b.length;
  /*
   * 动态规划表在 10k 行文件上会是 100M 格 —— 审阅场景不可能是那种输入，
   * 但仍设一个上限：超过它就退化成"整段替换"（诚实且不卡死）。
   */
  if (n * m > 4_000_000) {
    return [
      ...a.map((text) => ({ kind: "-" as const, text })),
      ...b.map((text) => ({ kind: "+" as const, text })),
    ].slice(0, opts.maxLines ?? 400);
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from<number>({ length: m + 1 }).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "-", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "+", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "-", text: a[i]! });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "+", text: b[j]! });
    j += 1;
  }
  const max = opts.maxLines ?? 400;
  return out.length > max ? [...out.slice(0, max), { kind: " ", text: `…（还有 ${out.length - max} 行）` }] : out;
}

/** 回滚一条改动时要做的动作。 */
export type RollbackAction =
  | { kind: "edit"; path: string; oldText: string; newText: string }
  | { kind: "delete"; path: string }
  | { kind: "impossible"; why: string };

/**
 * 一条改动怎么回滚。
 *
 * @param change 改动
 */
export function rollbackOf(change: FileChange): RollbackAction {
  if (change.tool === "edit_file") {
    if (change.before === undefined || change.after === undefined) {
      return { kind: "impossible", why: "这条改动没有记下前后正文" };
    }
    return { kind: "edit", path: change.path, oldText: change.after, newText: change.before };
  }
  if (change.reversible) return { kind: "delete", path: change.path };
  return { kind: "impossible", why: change.why ?? "这份改动没有留下原件" };
}

/** 按路径汇总（同一个文件的多条改动归到一组，先出现的在前）。 */
export function groupByPath(changes: readonly FileChange[]): Array<{ path: string; changes: FileChange[] }> {
  const order: string[] = [];
  const map = new Map<string, FileChange[]>();
  for (const change of changes) {
    if (!map.has(change.path)) {
      map.set(change.path, []);
      order.push(change.path);
    }
    map.get(change.path)!.push(change);
  }
  return order.map((path) => ({ path, changes: map.get(path)! }));
}

/** 改动统计（几个文件、几处可回滚）。 */
export function summarizeChanges(changes: readonly FileChange[]): {
  files: number;
  edits: number;
  writes: number;
  reversible: number;
} {
  const paths = new Set(changes.map((c) => c.path));
  return {
    files: paths.size,
    edits: changes.filter((c) => c.tool === "edit_file").length,
    writes: changes.filter((c) => c.tool === "write_file").length,
    reversible: changes.filter((c) => c.reversible).length,
  };
}
